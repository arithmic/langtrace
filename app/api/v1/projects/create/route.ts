import { DEFAULT_TESTS } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { generateApiKey, hashApiKey } from "@/lib/utils";
import { NextRequest, NextResponse } from "next/server";

// Create a default team for bypass projects
async function getOrCreateDefaultTeam() {
  const defaultTeamName = "Default Team";
  
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

// POST - Create project without authentication (for internal/docker network use)
export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { name, description, type, createDefaultTests = true, generateApiKey: shouldGenerateApiKey = true } = data;

    if (!name) {
      return NextResponse.json(
        { error: "Project name is required" },
        { status: 400 }
      );
    }

    // Get default team
    const defaultTeam = await getOrCreateDefaultTeam();
    
    let projectType = type || "default";
    let apiKeyHash = null;
    let apiKey = null;

    // Generate API key if requested
    if (shouldGenerateApiKey) {
      apiKey = generateApiKey();
      apiKeyHash = hashApiKey(apiKey);
    }

    // Create project
    const project = await prisma.project.create({
      data: {
        name: name,
        description: description || `Auto-created project: ${name}`,
        teamId: defaultTeam.id,
        type: projectType,
        apiKeyHash: apiKeyHash,
      },
    });

    // Create default tests if requested
    if (createDefaultTests) {
      for (const test of DEFAULT_TESTS) {
        await prisma.test.create({
          data: {
            name: test.name?.toLowerCase() ?? "",
            description: test.description ?? "",
            projectId: project.id,
          },
        });
      }
    }

    // Exclude apiKeyHash from response
    const { apiKeyHash: _, ...projectData } = project;

    const response = {
      project: projectData,
      api_key: apiKey,
      message: "Project created successfully"
    };

    return NextResponse.json(response, { status: 201 });

  } catch (error) {
    console.error("Error creating project:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}

// GET - Get project by ID without authentication
export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("project_id");
    
    if (!projectId) {
      return NextResponse.json(
        { error: "project_id parameter is required" },
        { status: 400 }
      );
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        Team: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Exclude apiKeyHash from response
    const { apiKeyHash: _, ...projectData } = project;

    return NextResponse.json({
      project: projectData,
      message: "Project found"
    });

  } catch (error) {
    console.error("Error fetching project:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}