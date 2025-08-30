import prisma from "@/lib/prisma";
import { generateApiKey, hashApiKey } from "@/lib/utils";
import { NextRequest, NextResponse } from "next/server";

// POST - Generate API key for a project without authentication (for internal/docker network use)
export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const { project_id } = data;

    if (!project_id) {
      return NextResponse.json(
        { error: "project_id is required" },
        { status: 400 }
      );
    }

    // Check if project exists
    const project = await prisma.project.findUnique({
      where: { id: project_id },
    });

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Generate new API key
    const apiKey = generateApiKey();
    const hash = hashApiKey(apiKey);

    // Update project with new API key
    await prisma.project.update({
      where: { id: project_id },
      data: { apiKeyHash: hash },
    });

    return NextResponse.json({
      project_id: project_id,
      api_key: apiKey,
      message: "API key generated successfully"
    }, { status: 201 });

  } catch (error) {
    console.error("Error generating API key:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}

// GET - Get project info by API key without authentication
export async function GET(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-api-key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "x-api-key header is required" },
        { status: 400 }
      );
    }

    const hash = hashApiKey(apiKey);
    
    const project = await prisma.project.findUnique({
      where: { apiKeyHash: hash },
      include: {
        Team: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: "Invalid API key or project not found" },
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
    console.error("Error fetching project by API key:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}