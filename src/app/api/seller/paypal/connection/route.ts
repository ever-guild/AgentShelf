import { connection } from "next/server";

import { merchantConnectionHttpHandlers } from "../../../../../server/paypal/merchant-connection-runtime";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return merchantConnectionHttpHandlers().status(request);
}

export async function POST(request: Request): Promise<Response> {
  return merchantConnectionHttpHandlers().start(request);
}
