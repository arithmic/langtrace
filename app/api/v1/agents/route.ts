import { ClickhouseBaseClient } from "@/lib/clients/scale3_clickhouse/client/client";
import prisma from "@/lib/prisma";
import { generateApiKey, hashApiKey } from "@/lib/utils";
import { NextRequest, NextResponse } from "next/server";
import sql from "sql-bricks";

// ClickHouse schema for agent-project mapping
const AGENT_PROJECT_TABLE = "agent_project_mapping";

// Helper function to format date for ClickHouse DateTime
function formatClickHouseDateTime(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

interface AgentProjectMapping {
  agent_name: string;
  project_id: string;
  api_key: string;
  created_at: string;
  updated_at: string;
}

// Initialize ClickHouse client
const clickhouseClient = ClickhouseBaseClient.getInstance();

// Ensure agent_project_mapping table exists
async function ensureAgentProjectTable() {
  const tableExists = await clickhouseClient.checkTableExists(AGENT_PROJECT_TABLE);
  
  if (!tableExists) {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${AGENT_PROJECT_TABLE} (
        agent_name String,
        project_id String,
        api_key String,
        created_at DateTime,
        updated_at DateTime
      ) ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY (agent_name)
      PRIMARY KEY (agent_name)
    `;
    
    console.log("Creating ClickHouse table with query:", createTableQuery);
    await clickhouseClient.create(createTableQuery);
    console.log("ClickHouse table created successfully");
  }
}

// Create a default team for agent-based projects
async function getOrCreateDefaultTeam() {
  const defaultTeamName = "Agent Projects Team";
  
  let team = await prisma.team.findFirst({
    where: {
      name: defaultTeamName,
    },
  });
  
  if (!team) {
    team = await prisma.team.create({
      data: {
        name: defaultTeamName,
        status: "active",
      },
    });
  }
  
  return team;
}

// GET - Get or create agent-project-apikey mapping
export async function GET(req: NextRequest) {
  try {
    const agentName = req.nextUrl.searchParams.get("agent_name");
    
    if (!agentName) {
      return NextResponse.json(
        { error: "agent_name parameter is required" },
        { status: 400 }
      );
    }

    await ensureAgentProjectTable();

    // Check if agent already exists in ClickHouse
    const queryString = `* FROM ${AGENT_PROJECT_TABLE} WHERE agent_name = '${agentName}' ORDER BY updated_at DESC LIMIT 1`;
    const existingAgent = await clickhouseClient.find<any[]>(sql.select(queryString));

    if (existingAgent.length > 0) {
      const agent = existingAgent[0];
      
      // Verify project still exists in PostgreSQL
      const project = await prisma.project.findUnique({
        where: { id: agent.project_id },
      });
      
      if (!project) {
        // Project was deleted, create a new one
        const newProject = await createProjectForAgent(agentName);
        const apiKey = generateApiKey();
        
        // Update ClickHouse record
        await updateAgentProjectMapping(agentName, newProject.id, apiKey);
        
        return NextResponse.json({
          agent_name: agentName,
          project_id: newProject.id,
          api_key: apiKey,
        });
      }
      
      // Check if API key is missing or invalid
      if (!agent.api_key || !project.apiKeyHash) {
        const apiKey = generateApiKey();
        const hash = hashApiKey(apiKey);
        
        // Update project with new API key
        await prisma.project.update({
          where: { id: project.id },
          data: { apiKeyHash: hash },
        });
        
        // Update ClickHouse record
        await updateAgentProjectMapping(agentName, project.id, apiKey);
        
        return NextResponse.json({
          agent_name: agentName,
          project_id: project.id,
          api_key: apiKey,
        });
      }
      
      // Everything exists, return existing data
      return NextResponse.json({
        agent_name: agentName,
        project_id: agent.project_id,
        api_key: agent.api_key,
      });
    }

    // Agent doesn't exist, create everything from scratch
    const project = await createProjectForAgent(agentName);
    const apiKey = generateApiKey();
    
    // Store in ClickHouse
    await createAgentProjectMapping(agentName, project.id, apiKey);
    
    return NextResponse.json({
      agent_name: agentName,
      project_id: project.id,
      api_key: apiKey,
    });

  } catch (error) {
    console.error("Error in agent management:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// POST - Manually create or update agent-project mapping
export async function POST(req: NextRequest) {
  try {
    const { agent_name } = await req.json();
    
    if (!agent_name) {
      return NextResponse.json(
        { error: "agent_name is required" },
        { status: 400 }
      );
    }

    await ensureAgentProjectTable();

    // Use the same logic as GET but force creation if needed
    const response = await GET(
      new NextRequest(`${req.url}?agent_name=${encodeURIComponent(agent_name)}`, {
        method: 'GET'
      })
    );
    
    return response;

  } catch (error) {
    console.error("Error in POST agent management:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// Helper functions
async function createProjectForAgent(agentName: string) {
  const defaultTeam = await getOrCreateDefaultTeam();
  const apiKey = generateApiKey();
  const hash = hashApiKey(apiKey);
  
  const project = await prisma.project.create({
    data: {
      name: `Agent: ${agentName}`,
      description: `Auto-created project for agent: ${agentName}`,
      teamId: defaultTeam.id,
      apiKeyHash: hash,
      type: "agent",
    },
  });
  
  return project;
}

async function createAgentProjectMapping(agentName: string, projectId: string, apiKey: string) {
  try {
    const now = formatClickHouseDateTime();
    
    const data = [{
      agent_name: agentName,
      project_id: projectId,
      api_key: apiKey,
      created_at: now,
      updated_at: now
    }];
    
    console.log("Inserting agent mapping data:", data);
    await clickhouseClient.insert(AGENT_PROJECT_TABLE, data);
    console.log("Successfully inserted agent mapping");
  } catch (error) {
    console.error("Error in createAgentProjectMapping:", error);
    throw error;
  }
}

async function updateAgentProjectMapping(agentName: string, projectId: string, apiKey: string) {
  try {
    // For updates, we need to preserve the original created_at but update the updated_at
    const currentTime = formatClickHouseDateTime();
    
    // Get the existing record to preserve created_at
    const queryString = `* FROM ${AGENT_PROJECT_TABLE} WHERE agent_name = '${agentName}' ORDER BY updated_at DESC LIMIT 1`;
    const existingRecords = await clickhouseClient.find<any[]>(sql.select(queryString));
    
    let createdAt = currentTime; // Default to current time if no existing record
    if (existingRecords.length > 0) {
      createdAt = existingRecords[0].created_at;
    }
    
    const data = [{
      agent_name: agentName,
      project_id: projectId,
      api_key: apiKey,
      created_at: createdAt, // Preserve original created_at
      updated_at: currentTime // Always update to current time
    }];
    
    console.log("Updating agent mapping data:", data);
    await clickhouseClient.insert(AGENT_PROJECT_TABLE, data);
    console.log("Successfully updated agent mapping");
  } catch (error) {
    console.error("Error in updateAgentProjectMapping:", error);
    throw error;
  }
}