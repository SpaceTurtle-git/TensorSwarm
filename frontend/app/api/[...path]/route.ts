import { NextRequest, NextResponse } from "next/server";

const MASTER_API_URL = (
  process.env.MASTER_API_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

type RouteContext = {
  params: {
    path: string[];
  };
};

async function proxyToMaster(request: NextRequest, { params }: RouteContext) {
  const path = params.path.map(encodeURIComponent).join("/");
  const apiPath = path === "healthz" ? "/healthz" : `/api/${path}`;
  const targetUrl = `${MASTER_API_URL}${apiPath}${request.nextUrl.search}`;
  const headers = new Headers();
  const contentType = request.headers.get("content-type");

  if (contentType) {
    headers.set("content-type", contentType);
  }

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      cache: "no-store",
    });

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown network error";
    return NextResponse.json(
      { detail: `Could not reach Master API at ${MASTER_API_URL}: ${reason}` },
      { status: 502 }
    );
  }
}

export const GET = proxyToMaster;
export const POST = proxyToMaster;
export const DELETE = proxyToMaster;
export const PUT = proxyToMaster;

// Never cache: every call is live cluster state.
export const dynamic = "force-dynamic";
