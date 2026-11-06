import { merchantConnectionHttpHandlers } from "../../../../../../server/paypal/merchant-connection-runtime";

export async function GET(request: Request): Promise<Response> {
  return merchantConnectionHttpHandlers().callback(request);
}
