import { merchantConnectionHttpHandlers } from "../../../../../../server/paypal/merchant-connection-runtime";

export async function POST(request: Request): Promise<Response> {
  return merchantConnectionHttpHandlers().refreshStatus(request);
}
