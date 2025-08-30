import { TraceService } from "@/lib/services/trace_service";
import {
  normalizeData,
  normalizeOTELData,
  prepareForClickhouse,
} from "@/lib/utils";
import { ClickhouseBaseClient } from "@/lib/clients/scale3_clickhouse/client/client";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import protobuf from "protobufjs";
import sql from "sql-bricks";

// ClickHouse client for agent API key validation
const clickhouseClient = ClickhouseBaseClient.getInstance();
const AGENT_PROJECT_TABLE = "agent_project_mapping";

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

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type");
    console.log("req : ", req);
    let data;
    if (contentType === "application/x-protobuf") {
      data = await decodeProtobuf(req);
      console.log("Decoded protobuf data:", JSON.stringify(data, null, 2));
    } else {
      data = await req.json();
    }

    const apiKey = req.headers.get("x-api-key");
    const userAgent = req.headers.get("user-agent");

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401 }
      );
    }

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