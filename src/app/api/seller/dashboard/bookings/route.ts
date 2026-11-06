import { getDashboardBookings } from "@/server/services/seller-dashboard";

import { datasetRoute } from "../dataset-route";

export const GET = datasetRoute((db, shop, query) => getDashboardBookings(db, shop, query));
