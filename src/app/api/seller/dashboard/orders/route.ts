import { getDashboardOrders } from "@/server/services/seller-dashboard";

import { datasetRoute } from "../dataset-route";

export const GET = datasetRoute((db, shop, query) => getDashboardOrders(db, shop, query));
