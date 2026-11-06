import { readDemandForAssistant } from "@/server/services/demand-insights";

import { datasetRoute } from "../../dashboard/dataset-route";

// What the assistant's read tools call. It reads the same aggregates as the page, for the session's
// shop, and takes only the strict filters in the contract.
export const GET = datasetRoute((db, shop, query) => readDemandForAssistant(db, shop, query));
