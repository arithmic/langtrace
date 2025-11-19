import { TraceService } from "@/lib/services/trace_service";
import {
  normalizeData,
  normalizeOTELData,
  prepareForClickhouse,
  calculatePriceFromUsage,
  hashApiKey,
} from "@/lib/utils";
import { ClickhouseBaseClient } from "@/lib/clients/scale3_clickhouse/client/client";
import { authOptions } from "@/lib/auth/options";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import protobuf from "protobufjs";
import sql from "sql-bricks";

// ClickHouse client for agent API key validation
const clickhouseClient = ClickhouseBaseClient.getInstance();
const AGENT_PROJECT_TABLE = "agent_project_mapping";
const SESSION_AGENT_MAPPING_TABLE = "session_agent_mapping";

// Function to validate agent API key and get project ID
async function getProjectFromAgentApiKey(apiKey: string): Promise<string | null> {
  try {
    const tableExists = await clickhouseClient.checkTableExists(AGENT_PROJECT_TABLE);
    if (!tableExists) {
      return null;
    }

    const queryString = `* FROM ${AGENT_PROJECT_TABLE} WHERE api_key = '${apiKey}' ORDER BY updated_at DESC LIMIT 1`;
    const results = await clickhouseClient.find<any[]>(sql.select(queryString));
    
    if (results.length > 0) {
      return results[0].project_id;
    }
    return null;
  } catch (error) {
    console.error("Error getting project from agent API key:", error);
    return null;
  }
}

// Enhanced authentication (supports both user sessions and agent API keys)
async function authenticateRequest(session: any, apiKey: string | null, projectId?: string) {
  // Check user session first
  if (session?.user) {
    const email = session.user.email as string;
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return { error: "User not found", status: 404 };
    }

    if (projectId) {
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          teamId: user.teamId,
        },
      });

      if (!project) {
        return { error: "User does not have access to this project", status: 403 };
      }
    }

    return { success: true, user, projectId };
  }

  // Check API key authentication
  if (apiKey) {
    if (projectId) {
      const project = await prisma.project.findFirst({
        where: { id: projectId },
      });

      if (!project) {
        return { error: "No projects found", status: 404 };
      }

      // Check traditional PostgreSQL API key
      let isValidApiKey = false;
      if (project.apiKeyHash && project.apiKeyHash === hashApiKey(apiKey)) {
        isValidApiKey = true;
      }
      
      // Check ClickHouse agent API keys
      if (!isValidApiKey) {
        const tableExists = await clickhouseClient.checkTableExists(AGENT_PROJECT_TABLE);
        if (tableExists) {
          const queryString = `* FROM ${AGENT_PROJECT_TABLE} WHERE api_key = '${apiKey}' AND project_id = '${projectId}' ORDER BY updated_at DESC LIMIT 1`;
          const results = await clickhouseClient.find<any[]>(sql.select(queryString));
          isValidApiKey = results.length > 0;
        }
      }

      if (!isValidApiKey) {
        return { error: "Unauthorized. Invalid API key", status: 401 };
      }

      return { success: true, projectId };
    } else {
      // Agent API key without projectId - get project from agent mapping
      const agentProjectId = await getProjectFromAgentApiKey(apiKey);
      if (!agentProjectId) {
        return { error: "Invalid API key or project not found", status: 401 };
      }
      return { success: true, projectId: agentProjectId };
    }
  }

  return { error: "Authentication required", status: 401 };
}

// Ensure session-agent mapping table exists
async function ensureSessionMappingTable() {
  try {
    const tableExists = await clickhouseClient.checkTableExists(SESSION_AGENT_MAPPING_TABLE);
    
    if (!tableExists) {
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ${SESSION_AGENT_MAPPING_TABLE} (
          session_id String,
          agent_name String,
          project_id String,
          first_seen DateTime,
          last_seen DateTime,
          span_count UInt32 DEFAULT 1
        ) ENGINE = ReplacingMergeTree(last_seen)
        ORDER BY (session_id, agent_name, project_id)
        PRIMARY KEY (session_id, agent_name)
      `;
      
      await clickhouseClient.create(createTableQuery);
      console.log("Session-agent mapping table created successfully");
    }
  } catch (error) {
    console.error("Error creating session-agent mapping table:", error);
  }
}

// Get agent name from project ID
async function getAgentNameFromProjectId(projectId: string): Promise<string | null> {
  try {
    const queryString = `agent_name FROM ${AGENT_PROJECT_TABLE} WHERE project_id = '${projectId}' ORDER BY updated_at DESC LIMIT 1`;
    const results = await clickhouseClient.find<any[]>(sql.select(queryString));
    return results.length > 0 ? results[0].agent_name : null;
  } catch (error) {
    console.warn("Failed to get agent name for project:", projectId, error);
    return null;
  }
}

// Update session-agent mapping during trace ingestion
async function updateSessionMapping(sessionId: string, agentName: string, projectId: string) {
  try {
    await ensureSessionMappingTable();
    
    // Check if this session_id + agent_name combination already exists
    const existingQueryString = `* FROM ${SESSION_AGENT_MAPPING_TABLE} WHERE session_id = '${sessionId}' AND agent_name = '${agentName}' LIMIT 1`;
    const existingResults = await clickhouseClient.find<any[]>(sql.select(existingQueryString));
    
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    
    if (existingResults.length > 0) {
      // Update existing record with new last_seen time and increment span_count
      const updateQuery = `
        ALTER TABLE ${SESSION_AGENT_MAPPING_TABLE} 
        UPDATE 
          last_seen = '${now}',
          span_count = span_count + 1
        WHERE session_id = '${sessionId}' AND agent_name = '${agentName}'
      `;
      await clickhouseClient.update(updateQuery);
      console.log(`Updated existing session mapping: ${sessionId} + ${agentName}`);
    } else {
      // Insert new record only if combination doesn't exist
      const data = [{
        session_id: sessionId,
        agent_name: agentName,
        project_id: projectId,
        first_seen: now,
        last_seen: now,
        span_count: 1
      }];
      
      await clickhouseClient.insert(SESSION_AGENT_MAPPING_TABLE, data);
      console.log(`Created new session mapping: ${sessionId} + ${agentName}`);
    }
  } catch (error) {
    console.warn("Failed to update session mapping:", error);
    // Don't fail the main trace ingestion if session mapping fails
  }
}

// Hierarchical trace processing
interface HierarchicalTrace {
  trace: any;
  children: any[];
  cost: number;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    total_tokens: number;
  };
  input_cost: number;
  output_cost: number;
  cached_input_cost: number;
  total_cost: number;
}

function processHierarchicalTraces(spans: any[]): HierarchicalTrace[] {
  const traceGroups = spans.reduce((acc, span) => {
    if (!acc[span.trace_id]) {
      acc[span.trace_id] = [];
    }
    acc[span.trace_id].push(span);
    return acc;
  }, {} as Record<string, any[]>);

  const hierarchicalTraces: HierarchicalTrace[] = [];

  Object.values(traceGroups).forEach((traceSpans: any) => {
    const spanMap = new Map<string, any>(traceSpans.map((span: any) => [span.span_id, span]));
    
    const rootSpans = traceSpans.filter((span: any) => {
      return !span.parent_id || span.parent_id === "" || !spanMap.has(span.parent_id);
    });

    rootSpans.sort((a: any, b: any) => {
      const timeA = new Date(a.start_time).getTime();
      const timeB = new Date(b.start_time).getTime();
      return timeA - timeB;
    });

    rootSpans.forEach((rootSpan: any) => {
      const hierarchicalTrace = buildHierarchicalTrace(rootSpan, traceSpans, spanMap);
      hierarchicalTraces.push(hierarchicalTrace);
    });
  });

  return hierarchicalTraces;
}

function buildHierarchicalTrace(rootSpan: any, allSpans: any[], spanMap: Map<string, any>): HierarchicalTrace {
  const children = findChildren(rootSpan.span_id, allSpans);
  
  children.sort((a: any, b: any) => {
    const timeA = new Date(a.start_time).getTime();
    const timeB = new Date(b.start_time).getTime();
    return timeA - timeB;
  });
  
  const allDescendants = getAllDescendants(rootSpan, allSpans);
  const aggregatedMetrics = calculateAggregatedMetrics([rootSpan, ...allDescendants]);

  return {
    trace: rootSpan,
    children: children.map(child => buildChildTrace(child, allSpans, spanMap)),
    cost: aggregatedMetrics.total_cost,
    tokens: aggregatedMetrics.tokens,
    input_cost: aggregatedMetrics.input_cost,
    output_cost: aggregatedMetrics.output_cost,
    cached_input_cost: aggregatedMetrics.cached_input_cost,
    total_cost: aggregatedMetrics.total_cost
  };
}

function buildChildTrace(span: any, allSpans: any[], spanMap: Map<string, any>): any {
  const children = findChildren(span.span_id, allSpans);
  
  children.sort((a: any, b: any) => {
    const timeA = new Date(a.start_time).getTime();
    const timeB = new Date(b.start_time).getTime();
    return timeA - timeB;
  });
  
  return {
    trace: span,
    children: children.map(child => buildChildTrace(child, allSpans, spanMap))
  };
}

function findChildren(parentSpanId: string, allSpans: any[]): any[] {
  return allSpans.filter(span => span.parent_id === parentSpanId);
}

function getAllDescendants(rootSpan: any, allSpans: any[]): any[] {
  const descendants: any[] = [];
  const children = findChildren(rootSpan.span_id, allSpans);
  
  children.forEach(child => {
    descendants.push(child);
    descendants.push(...getAllDescendants(child, allSpans));
  });
  
  return descendants;
}

function calculateAggregatedMetrics(spans: any[]) {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalTokens = 0;
  let totalInputCost = 0;
  let totalOutputCost = 0;
  let totalCachedInputCost = 0;

  spans.forEach(span => {
    if (span.attributes) {
      const attributes = typeof span.attributes === 'string' ? JSON.parse(span.attributes) : span.attributes;
      
      const llmTokenCounts = attributes['llm.token.counts'] ? 
        (typeof attributes['llm.token.counts'] === 'string' ? 
          JSON.parse(attributes['llm.token.counts']) : attributes['llm.token.counts']) : {};
      
      const inputTokens = parseInt(llmTokenCounts.input_tokens || 0) + 
                         parseInt(attributes['gen_ai.usage.input_tokens'] || 0) + 
                         parseInt(attributes['gen_ai.usage.prompt_tokens'] || 0);
      
      const outputTokens = parseInt(llmTokenCounts.output_tokens || 0) + 
                          parseInt(attributes['gen_ai.usage.output_tokens'] || 0) + 
                          parseInt(attributes['gen_ai.usage.completion_tokens'] || 0);
      
      const cachedInputTokens = parseInt(attributes['gen_ai.usage.cached_tokens'] || 0);
      
      const tokens = parseInt(llmTokenCounts.total_tokens || 0) + 
                    parseInt(attributes['gen_ai.usage.total_tokens'] || 0) + 
                    parseInt(attributes['gen_ai.request.total_tokens'] || 0);

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalCachedInputTokens += cachedInputTokens;
      totalTokens += tokens || (inputTokens + outputTokens);

      if (attributes['langtrace.service.type'] === 'llm' && (inputTokens > 0 || outputTokens > 0)) {
        const model = attributes['llm.model'] || 
                     attributes['gen_ai.response.model'] || 
                     attributes['gen_ai.request.model'] || '';
        
        const vendor = (attributes['langtrace.service.name'] || '').toLowerCase();
        
        if (model && vendor) {
          const cost = calculatePriceFromUsage(vendor, model, {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_input_tokens: cachedInputTokens
          });

          totalInputCost += cost.input;
          totalOutputCost += cost.output;
          totalCachedInputCost += cost.cached_input;
        }
      }
    }
  });

  return {
    tokens: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cached_input_tokens: totalCachedInputTokens,
      total_tokens: totalTokens
    },
    input_cost: totalInputCost,
    output_cost: totalOutputCost,
    cached_input_cost: totalCachedInputCost,
    total_cost: totalInputCost + totalOutputCost + totalCachedInputCost
  };
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type");
    const apiKey = req.headers.get("x-api-key");
    const userAgent = req.headers.get("user-agent");
    const sessionId = req.headers.get("x-session-id");

    // Check if this is a query request (JSON with query params) vs ingestion
    let data;
    if (contentType === "application/x-protobuf") {
      data = await decodeProtobuf(req);
      console.log("Decoded protobuf data:", JSON.stringify(data, null, 2));
    } else {
      data = await req.json();
    }

    // Check if this is a query request (has sessionId in body or wants to retrieve traces)
    if (data.sessionId || data.query === true || data.retrieve === true) {
      return await handleTraceQuery(apiKey, data);
    }

    // For trace ingestion, API key is required
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required for trace ingestion" },
        { status: 401 }
      );
    }

    // Otherwise, this is trace ingestion (existing functionality)
    console.log("req : ", req);

    // Get project ID from agent API key (no authentication, just lookup)
    const projectId = await getProjectFromAgentApiKey(apiKey);
    if (!projectId) {
      return NextResponse.json(
        { error: "Invalid API key or project not found" },
        { status: 401 }
      );
    }

    // Normalize and prepare data for Clickhouse
    let normalized = [];
    let spans: any = [];
    if (
      userAgent?.toLowerCase().includes("otel-otlp") ||
      userAgent?.toLowerCase().includes("opentelemetry")
    ) {
      // coming from an OTEL exporter
      data.resourceSpans?.[0].scopeSpans.forEach((scopeSpan: any) => {
        scopeSpan.spans.forEach((span: any) => {
          console.log(`Raw span "${span.name}" events:`, JSON.stringify(span.events, null, 2));
          spans.push(span);
        });
      });
      normalized = prepareForClickhouse(normalizeOTELData(spans));
    } else {
      normalized = prepareForClickhouse(normalizeData(data));
    }

    // Inject session ID into all spans if provided via header OR extract from span attributes
    let extractedSessionId = sessionId;
    
    // If no session_id header, try to extract from span attributes
    if (!extractedSessionId && normalized.length > 0) {
      for (const span of normalized) {
        if (span.attributes) {
          const attrs = typeof span.attributes === 'string' ? JSON.parse(span.attributes) : span.attributes;
          if (attrs['session_id'] || attrs['session.id']) {
            extractedSessionId = attrs['session_id'] || attrs['session.id'];
            console.log(`Extracted session_id from span attributes: ${extractedSessionId}`);
            break;
          }
        }
      }
    }
    
    if (extractedSessionId && normalized.length > 0) {
      normalized = normalized.map((span: any) => ({
        ...span,
        session_id: extractedSessionId
      }));
      
      // Update session-agent mapping for efficient querying
      const agentName = await getAgentNameFromProjectId(projectId);
      if (agentName) {
        await updateSessionMapping(extractedSessionId, agentName, projectId);
      }
    }
    const traceService = new TraceService();

    // Add traces to Clickhouse
    await traceService.AddSpans(normalized, projectId);
    return NextResponse.json(
      { message: "Traces added successfully" },
      { status: 200 }
    );
  } catch (err: unknown) {
    const error = err as Error;

    return NextResponse.json(
      {
        name: error?.name || "UnknownError",
        message:
          error?.message || "Something went wrong while ingesting traces",
        stack: error?.stack,
        fullError:
          error instanceof Error
            ? JSON.stringify(error, Object.getOwnPropertyNames(error))
            : JSON.stringify(error),
      },
      { status: 404 }
    );
  }
}

// Handle trace queries with enhanced features
async function handleTraceQuery(apiKey: string | null, queryParams: any) {
  try {
    const { 
      sessionId, 
      projectId,
      page = 1, 
      pageSize = 50, 
      filters = { filters: [], operation: "AND" },
      hierarchical = false,
      keyword
    } = queryParams;

    if (sessionId) {
      // Case 1: Get traces by session ID (across all agents) - NO AUTH REQUIRED
      return await getTracesBySession(sessionId, page, pageSize, filters, hierarchical);
    } else {
      // Case 2: Get traces by agent/project - AUTH REQUIRED
      const session = await getServerSession(authOptions);
      const auth = await authenticateRequest(session, apiKey, projectId);
      if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
      }
      
      const targetProjectId = auth.projectId || projectId;
      if (!targetProjectId) {
        return NextResponse.json(
          { error: "Project ID is required" },
          { status: 400 }
        );
      }
      return await getTracesByAgent(targetProjectId, page, pageSize, filters, hierarchical, keyword);
    }
  } catch (error) {
    console.error("Error handling trace query:", error);
    return NextResponse.json(
      { error: "Failed to query traces", message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// Case 1: Get traces by session ID (across all agents) - OPTIMIZED
async function getTracesBySession(sessionId: string, page: number, pageSize: number, filters: any, hierarchical: boolean = false) {
  try {
    await ensureSessionMappingTable();
    
    // STEP 1: Fast lookup - find which agents used this session (instead of checking all agents!)
    const sessionMappingQuery = sql
      .select("DISTINCT agent_name", "project_id")
      .from(SESSION_AGENT_MAPPING_TABLE)
      .where(sql.eq("session_id", sessionId));

    const sessionAgents = await clickhouseClient.find<any[]>(sessionMappingQuery);

    if (sessionAgents.length === 0) {
      return NextResponse.json({
        session_id: sessionId,
        agents: [],
        total_traces: 0,
        optimization_note: "Used session mapping - no agents found for this session"
      });
    }

    console.log(`Session ${sessionId}: Found ${sessionAgents.length} participating agents (instead of querying all agents)`);

    // Add session filter
    filters.filters.push({
      key: "session_id",
      operation: "EQUALS",
      type: "property",
      value: sessionId
    });

    const agentTraces = [];
    let totalTraces = 0;

    // STEP 2: Query only the participating agents (huge performance gain!)
    for (const sessionAgent of sessionAgents) {
      const { agent_name, project_id } = sessionAgent;
      
      try {
        const tableExists = await clickhouseClient.checkTableExists(project_id);
        if (!tableExists) continue;

        const traceService = new TraceService();
        const tracesResult = await traceService.GetTracesInProjectPaginated(
          project_id,
          1,
          1000,
          filters
        );

        const flatTraces = tracesResult.result.flat();
        
        if (flatTraces.length > 0) {
          let processedTraces: any = flatTraces;
          
          // Apply hierarchical processing if requested
          if (hierarchical) {
            processedTraces = processHierarchicalTraces(flatTraces);
          }

          agentTraces.push({
            agent_name,
            project_id,
            traces: processedTraces,
            trace_count: flatTraces.length
          });
          totalTraces += flatTraces.length;
        }

      } catch (error) {
        console.warn(`Failed to get traces for agent ${agent_name}:`, error);
      }
    }

    // Sort agents by trace count
    agentTraces.sort((a, b) => b.trace_count - a.trace_count);

    return NextResponse.json({
      session_id: sessionId,
      agents: agentTraces,
      total_agents: agentTraces.length,
      total_traces: totalTraces,
      hierarchical,
      performance_stats: {
        agents_checked: sessionAgents.length,
        optimization: "Used session-agent mapping table for fast lookup"
      }
    });

  } catch (error) {
    console.error("Error in optimized session query:", error);
    // Fallback to old method if session mapping fails
    console.warn("Falling back to querying all agents");
    return await getTracesBySessionFallback(sessionId, page, pageSize, filters, hierarchical);
  }
}

// Fallback method (old approach) in case session mapping fails
async function getTracesBySessionFallback(sessionId: string, page: number, pageSize: number, filters: any, hierarchical: boolean = false) {
  // Get all agent projects (old way)
  const agentProjects = await clickhouseClient.find<any[]>(
    sql.select("agent_name", "project_id").from(AGENT_PROJECT_TABLE)
  );

  console.warn(`Fallback: Querying ${agentProjects.length} agents for session ${sessionId}`);

  if (agentProjects.length === 0) {
    return NextResponse.json({
      session_id: sessionId,
      agents: [],
      total_traces: 0
    });
  }

  // Add session filter
  filters.filters.push({
    key: "session_id",
    operation: "EQUALS",
    type: "property",
    value: sessionId
  });

  const agentTraces = [];
  let totalTraces = 0;

  // Query each agent's traces for this session
  for (const agentProject of agentProjects) {
    const { agent_name, project_id } = agentProject;
    
    try {
      const tableExists = await clickhouseClient.checkTableExists(project_id);
      if (!tableExists) continue;

      const traceService = new TraceService();
      const tracesResult = await traceService.GetTracesInProjectPaginated(
        project_id,
        1,
        1000,
        filters
      );

      const flatTraces = tracesResult.result.flat();
      
      if (flatTraces.length > 0) {
        let processedTraces: any = flatTraces;
        
        if (hierarchical) {
          processedTraces = processHierarchicalTraces(flatTraces);
        }

        agentTraces.push({
          agent_name,
          project_id,
          traces: processedTraces,
          trace_count: flatTraces.length
        });
        totalTraces += flatTraces.length;
      }

    } catch (error) {
      console.warn(`Failed to get traces for agent ${agent_name}:`, error);
    }
  }

  agentTraces.sort((a, b) => b.trace_count - a.trace_count);

  return NextResponse.json({
    session_id: sessionId,
    agents: agentTraces,
    total_agents: agentTraces.length,
    total_traces: totalTraces,
    hierarchical,
    performance_stats: {
      agents_checked: agentProjects.length,
      optimization: "FALLBACK - queried all agents"
    }
  });
}

// Case 2: Get traces by agent/project (all sessions for this project)
async function getTracesByAgent(projectId: string, page: number, pageSize: number, filters: any, hierarchical: boolean = false, keyword?: string) {
  const traceService = new TraceService();
  const tracesResult = await traceService.GetTracesInProjectPaginated(
    projectId,
    page,
    pageSize,
    filters,
    keyword
  );

  let processedTraces: any = tracesResult.result;
  
  // Apply hierarchical processing if requested
  if (hierarchical) {
    const flatSpans = tracesResult.result.flat();
    processedTraces = processHierarchicalTraces(flatSpans);
  }

  return NextResponse.json({
    project_id: projectId,
    traces: processedTraces,
    metadata: tracesResult.metadata,
    hierarchical
  });
}

// GET method removed since this is purely for sending traces
// If you need to fetch traces, use /api/v1/get-traces instead

async function decodeProtobuf(req: NextRequest) {
  // Load the Protobuf schema
  const loadProtobuf = async () => {
    return protobuf.load(path.resolve("proto", "trace.proto"));
  };

  // Get raw data from the request body as ArrayBuffer
  const arrayBuffer = await req.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer); // Convert to Uint8Array

  // Load and decode the Protobuf schema
  const root = await loadProtobuf();

  const TracesData = root.lookupType("opentelemetry.proto.trace.v1.TracesData");

  // Decode the Protobuf binary data
  const decodedData = TracesData.decode(uint8Array);

  // Do something with decoded data (e.g., store in a database)

  const data = JSON.parse(JSON.stringify(decodedData, null, 2));
  return data;
}