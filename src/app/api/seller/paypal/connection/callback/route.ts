import { connection } from "next/server";

import { merchantConnectionHttpHandlers } from "../../../../../../server/paypal/merchant-connection-runtime";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return merchantConnectionHttpHandlers().callback(request);
}
