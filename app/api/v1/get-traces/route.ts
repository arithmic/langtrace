import { authOptions } from "@/lib/auth/options";
import prisma from "@/lib/prisma";
import { TraceService } from "@/lib/services/trace_service";
import { calculatePriceFromUsage, hashApiKey } from "@/lib/utils";
import { ClickhouseBaseClient } from "@/lib/clients/scale3_clickhouse/client/client";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";
import sql from "sql-bricks";

// ClickHouse client for agent API key validation
const clickhouseClient = ClickhouseBaseClient.getInstance();
const AGENT_PROJECT_TABLE = "agent_project_mapping";

// Function to check if API key exists in agent system (ClickHouse)
async function validateAgentApiKey(apiKey: string, projectId: string): Promise<boolean> {
  try {
    const tableExists = await clickhouseClient.checkTableExists(AGENT_PROJECT_TABLE);
    if (!tableExists) {
      return false;
    }

    const queryString = `* FROM ${AGENT_PROJECT_TABLE} WHERE api_key = '${apiKey}' AND project_id = '${projectId}' ORDER BY updated_at DESC LIMIT 1`;
    const results = await clickhouseClient.find<any[]>(sql.select(queryString));
    
    return results.length > 0;
  } catch (error) {
    console.error("Error validating agent API key:", error);
    return false;
  }
}

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
  // Group spans by trace_id first
  const traceGroups = spans.reduce((acc, span) => {
    if (!acc[span.trace_id]) {
      acc[span.trace_id] = [];
    }
    acc[span.trace_id].push(span);
    return acc;
  }, {} as Record<string, any[]>);

  const hierarchicalTraces: HierarchicalTrace[] = [];

  // Process each trace group
  Object.values(traceGroups).forEach((traceSpans: any) => {
    // Find root spans (no parent_id or parent_id not in current trace)
    const spanMap = new Map<string, any>(traceSpans.map((span: any) => [span.span_id, span]));
    
    const rootSpans = traceSpans.filter((span: any) => {
      return !span.parent_id || span.parent_id === "" || !spanMap.has(span.parent_id);
    });

    // Sort root spans by start_time chronologically  
    rootSpans.sort((a: any, b: any) => {
      const timeA = new Date(a.start_time).getTime();
      const timeB = new Date(b.start_time).getTime();
      return timeA - timeB;
    });

    // For each root span, build the hierarchical structure
    rootSpans.forEach((rootSpan: any) => {
      const hierarchicalTrace = buildHierarchicalTrace(rootSpan, traceSpans, spanMap);
      hierarchicalTraces.push(hierarchicalTrace);
    });
  });

  return hierarchicalTraces;
}

function buildHierarchicalTrace(rootSpan: any, allSpans: any[], spanMap: Map<string, any>): HierarchicalTrace {
  const children = findChildren(rootSpan.span_id, allSpans);
  
  // Sort children by start_time chronologically
  children.sort((a: any, b: any) => {
    const timeA = new Date(a.start_time).getTime();
    const timeB = new Date(b.start_time).getTime();
    return timeA - timeB;
  });
  
  // Calculate aggregated tokens and costs for the entire hierarchy
  const allDescendants = getAllDescendants(rootSpan, allSpans);
  const aggregatedMetrics = calculateAggregatedMetrics([rootSpan, ...allDescendants]);

  return {
    trace: rootSpan,
    children: children.map(child => buildChildTrace(child, allSpans, spanMap)),
    cost: aggregatedMetrics.total_cost, // Legacy field for backward compatibility
    tokens: aggregatedMetrics.tokens,
    input_cost: aggregatedMetrics.input_cost,
    output_cost: aggregatedMetrics.output_cost,
    cached_input_cost: aggregatedMetrics.cached_input_cost,
    total_cost: aggregatedMetrics.total_cost
  };
}

function buildChildTrace(span: any, allSpans: any[], spanMap: Map<string, any>): any {
  const children = findChildren(span.span_id, allSpans);
  
  // Sort children by start_time chronologically
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
      
      // Extract token counts from various possible attribute keys
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

      // Calculate cost if this is an LLM span
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
    const session = await getServerSession(authOptions);
    const apiKey = req.headers.get("x-api-key");
    let { page, pageSize, projectId, filters, group, keyword } = await req.json();

    // Enhanced authentication logic (supports both traditional and agent API keys)
    if (!session || !session.user) {
      if (apiKey) {
        const project = await prisma.project.findFirst({
          where: {
            id: projectId,
          },
        });

        if (!project) {
          return NextResponse.json(
            { error: "No projects found" },
            { status: 404 }
          );
        }

        // Check traditional PostgreSQL API key first
        let isValidApiKey = false;
        if (project.apiKeyHash && project.apiKeyHash === hashApiKey(apiKey)) {
          isValidApiKey = true;
        }
        
        // If traditional API key validation fails, check ClickHouse agent API keys
        if (!isValidApiKey) {
          isValidApiKey = await validateAgentApiKey(apiKey, projectId);
        }

        if (!isValidApiKey) {
          return NextResponse.json(
            { error: "Unauthorized. Invalid API key" },
            { status: 401 }
          );
        }

        if (pageSize > 100) {
          return NextResponse.json(
            { error: "Page size cannot be more than 100" },
            { status: 400 }
          );
        }

        // Set defaults for API Access
        group = true;
        filters = { filters: [], operation: "OR" };
      } else {
        redirect("/login");
      }
    } else {
      // Check if user has access to the project
      const email = session?.user?.email as string;
      const user = await prisma.user.findUnique({
        where: {
          email,
        },
      });

      if (!user) {
        return NextResponse.json(
          {
            message: "user not found",
          },
          { status: 404 }
        );
      }

      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          teamId: user.teamId,
        },
      });

      if (!project) {
        return NextResponse.json(
          {
            message: "User does not have access to this project",
          },
          { status: 403 }
        );
      }
    }

    // Get traces using the existing TraceService
    const traceService = new TraceService();
    const tracesResult = await traceService.GetTracesInProjectPaginated(
      projectId,
      page,
      pageSize,
      filters,
      keyword
    );

    // Flatten the traces array since GetTracesInProjectPaginated returns Span[][]
    const flatSpans = tracesResult.result.flat();

    // Process traces into hierarchical structure
    const hierarchicalTraces = processHierarchicalTraces(flatSpans);

    return NextResponse.json(
      {
        traces: hierarchicalTraces,
        metadata: tracesResult.metadata
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error in /api/v1/get-traces:", error);
    return NextResponse.json(
      {
        message: "Something went wrong while fetching hierarchical traces",
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}