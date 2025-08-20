import { authOptions } from "@/lib/auth/options";
import { TraceService } from "@/lib/services/trace_service";
import {
  authApiKey,
  normalizeData,
  normalizeOTELData,
  prepareForClickhouse,
} from "@/lib/utils";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import protobuf from "protobufjs";
import { gunzip } from "zlib";
import { promisify } from "util";

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type");
    // console.log("content-type",contentType);
    // console.log("req : ",req);
    let data;
    if (contentType === "application/x-protobuf") {
      data = await decodeProtobuf(req);
      console.log("Decoded protobuf data:", JSON.stringify(data, null, 2));
    } else {
      data = await req.json();
    }

    const apiKey = req.headers.get("x-api-key");
    // console.error("APi key = ",apiKey)
    // console.error("data = ",data);
    const userAgent = req.headers.get("user-agent");

    const response = await authApiKey(apiKey!);
    if (response.status !== 200) {
      return response;
    }

    // Get project data
    const projectData = await response.json();

    // Normalize and prepare data for Clickhouse
    let normalized = [];
    let spans: any = [];
    if (
      userAgent?.toLowerCase().includes("otel-otlp") ||
      userAgent?.toLowerCase().includes("opentelemetry")
    ) {
      // coming from an OTEL exporter
      console.log("Processing OTEL data, resourceSpans:", data.resourceSpans);
      if (data.resourceSpans && data.resourceSpans.length > 0) {
        data.resourceSpans.forEach((resourceSpan: any) => {
          resourceSpan.scopeSpans?.forEach((scopeSpan: any) => {
            scopeSpan.spans?.forEach((span: any) => spans.push(span));
          });
        });
      }
      console.log("Extracted spans:", spans.length, spans);
      
      // Convert base64 trace/span IDs to hex format for protobuf data
      const processedSpans = spans.map((span: any) => {
        const processed = { ...span };
        
        // Convert base64 trace ID to hex if it looks like base64
        if (span.traceId && span.traceId.includes('=')) {
          try {
            const buffer = Buffer.from(span.traceId, 'base64');
            processed.traceId = buffer.toString('hex');
            console.log(`Converted trace ID from ${span.traceId} to ${processed.traceId}`);
          } catch (e) {
            console.log('Failed to convert trace ID:', e);
          }
        }
        
        // Convert base64 span ID to hex if it looks like base64
        if (span.spanId && span.spanId.includes('=')) {
          try {
            const buffer = Buffer.from(span.spanId, 'base64');
            processed.spanId = buffer.toString('hex');
            console.log(`Converted span ID from ${span.spanId} to ${processed.spanId}`);
          } catch (e) {
            console.log('Failed to convert span ID:', e);
          }
        }
        
        // Convert span kind from string to number if needed
        if (typeof span.kind === 'string') {
          const kindMap: { [key: string]: number } = {
            'SPAN_KIND_UNSPECIFIED': 0,
            'SPAN_KIND_INTERNAL': 1,
            'SPAN_KIND_SERVER': 2,
            'SPAN_KIND_CLIENT': 3,
            'SPAN_KIND_PRODUCER': 4,
            'SPAN_KIND_CONSUMER': 5
          };
          processed.kind = kindMap[span.kind] || 0;
          console.log(`Converted span kind from ${span.kind} to ${processed.kind}`);
        }
        
        return processed;
      });
      
      normalized = prepareForClickhouse(normalizeOTELData(processedSpans));
      console.log("Normalized data:", normalized.length, normalized);
    } else {
      normalized = prepareForClickhouse(normalizeData(data));
    }
    const traceService = new TraceService();

    // Add traces to Clickhouse
    await traceService.AddSpans(normalized, projectData.data.project.id);
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
      { status: 500 }
    );
  }
}

async function decodeProtobuf(req: NextRequest) {
  const gunzipAsync = promisify(gunzip);
  
  // Load the Protobuf schema
  const loadProtobuf = async () => {
    return protobuf.load(path.resolve("proto", "trace.proto"));
  };

  // Get raw data from the request body as ArrayBuffer
  const arrayBuffer = await req.arrayBuffer();
  let uint8Array = new Uint8Array(arrayBuffer);

  // Check if data is gzipped and decompress if needed
  const contentEncoding = req.headers.get("content-encoding");
  if (contentEncoding === "gzip") {
    console.log("Decompressing gzipped data...");
    const decompressed = await gunzipAsync(Buffer.from(uint8Array));
    uint8Array = new Uint8Array(decompressed);
  }

  // Load and decode the Protobuf schema
  const root = await loadProtobuf();

  const TracesData = root.lookupType("opentelemetry.proto.trace.v1.TracesData");

  // Decode the Protobuf binary data
  const decodedData = TracesData.decode(uint8Array);

  const data = JSON.parse(JSON.stringify(decodedData, null, 2));
  return data;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const searchParams = url.searchParams.toString();
    const headers = Object.fromEntries(req.headers.entries());
    
    const forwardedRequest = new Request(
      `http://localhost:3000/api/trace${searchParams ? `?${searchParams}` : ""}`,
      {
        method: "GET",
        headers: headers,
      }
    );

    const response = await fetch(forwardedRequest);
    const responseData = await response.text();
    
    return new NextResponse(responseData, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
  } catch (error) {
    console.error("Error forwarding request to /api/trace:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}