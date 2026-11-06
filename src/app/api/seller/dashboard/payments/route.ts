import { getDashboardPayments } from "@/server/services/seller-dashboard";

import { datasetRoute } from "../dataset-route";

export const GET = datasetRoute((db, shop, query) => getDashboardPayments(db, shop, query));
