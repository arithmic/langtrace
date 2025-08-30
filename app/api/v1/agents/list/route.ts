import { ClickhouseBaseClient } from "@/lib/clients/scale3_clickhouse/client/client";
import { NextRequest, NextResponse } from "next/server";
import sql from "sql-bricks";

// ClickHouse table for agent-project mapping
const AGENT_PROJECT_TABLE = "agent_project_mapping";

// Initialize ClickHouse client
const clickhouseClient = ClickhouseBaseClient.getInstance();

// GET - List all agent-project-apikey mappings
export async function GET(req: NextRequest) {
  try {
    // Check if the agent_project_mapping table exists
    const tableExists = await clickhouseClient.checkTableExists(AGENT_PROJECT_TABLE);
    
    if (!tableExists) {
      return NextResponse.json({
        agents: [],
        message: "No agent mappings found - table doesn't exist yet"
      });
    }

    // Get all agent mappings, using the latest entry for each agent (due to ReplacingMergeTree)
    const queryString = `agent_name, project_id, api_key, created_at, updated_at FROM ${AGENT_PROJECT_TABLE} ORDER BY agent_name, updated_at DESC`;
    const agentMappings = await clickhouseClient.find<any[]>(sql.select(queryString));

    // Since we're using ReplacingMergeTree, we need to deduplicate by agent_name
    // and get the most recent entry for each agent
    const deduplicatedMappings = new Map();
    
    agentMappings.forEach((mapping: any) => {
      if (!deduplicatedMappings.has(mapping.agent_name) || 
          new Date(mapping.updated_at) > new Date(deduplicatedMappings.get(mapping.agent_name).updated_at)) {
        deduplicatedMappings.set(mapping.agent_name, mapping);
      }
    });

    // Convert map values to array and sort by agent_name
    const agents = Array.from(deduplicatedMappings.values()).sort((a, b) => 
      a.agent_name.localeCompare(b.agent_name)
    );

    return NextResponse.json({
      agents: agents,
      total_count: agents.length,
      message: `Found ${agents.length} agent(s)`
    });

  } catch (error) {
    console.error("Error listing agents:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error),
        agents: []
      },
      { status: 500 }
    );
  }
}