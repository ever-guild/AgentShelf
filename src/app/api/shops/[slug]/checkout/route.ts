import { getDb } from "@/server/db";
import { storefrontCheckoutResponse } from "@/server/services/storefront";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return storefrontCheckoutResponse(request, slug, getDb());
}
