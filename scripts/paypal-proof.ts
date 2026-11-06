import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client,
  Environment,
  OrderStatus,
  OrdersController,
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  type Order,
  type OrderRequest,
} from "@paypal/paypal-server-sdk";

const API_TIMEOUT_MS = 12_000;
const IDEMPOTENCY_WINDOW_MS = 6 * 60 * 60 * 1000;
const SHOP_REFS = ["DEMO_PHONE_WORKSHOP", "DEMO_SECOND_SHOP"] as const;
const AMOUNT_CURRENCY = "EUR";
const STATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.local/paypal-proof",
);

type ShopRef = (typeof SHOP_REFS)[number];
type Command = "create" | "inspect" | "capture";
type ProofRecord = {
  reference: string;
  shopRef: ShopRef;
  merchantId: string;
  amount: string;
  currency: typeof AMOUNT_CURRENCY;
  createRequestId: string;
  createCreatedAt: number;
  createPayload: OrderRequest;
  createHttpStatus?: number;
  createState: "pending" | "created" | "completed";
  orderId?: string;
  lastGetHttpStatus?: number;
  captureRequestId?: string;
  captureStartedAt?: number;
  captureHttpStatus?: number;
  captureState?: "pending" | "completed" | "observed";
  captureId?: string;
};
type ProofJournal = { version: 1; records: ProofRecord[] };
type CliArgs = { command: Command; flags: Record<string, string | boolean> };

export class ProofError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "ProofError";
  }
}

export function createOrdersApi(
  clientId: string,
  clientSecret: string,
  testAdapter?: unknown,
): OrdersController {
  const client = new Client({
    environment: Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: clientId,
      oAuthClientSecret: clientSecret,
    },
    httpClientOptions: {
      timeout: API_TIMEOUT_MS,
      retryConfig: {
        maxNumberOfRetries: 0,
        retryOnTimeout: false,
        maximumRetryWaitTime: 0,
        httpMethodsToRetry: ["GET", "PUT"],
      },
    },
    // The pinned SDK forwards this Axios option to both OAuth and Orders requests
    unstable_httpClientOptions: {
      maxRedirects: 0,
      ...(testAdapter ? { adapter: testAdapter } : {}),
    },
  });
  return new OrdersController(client);
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    throw new ProofError(usage(), 0);
  }
  const command = argv[0];
  if (command !== "create" && command !== "inspect" && command !== "capture") {
    throw new ProofError(usage(), 2);
  }

  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--confirm-human-approved") {
      if (flags[key]) throw new ProofError("Duplicate command option", 2);
      flags[key] = true;
      continue;
    }
    if (!key?.startsWith("--") || key.length < 3 || index + 1 >= argv.length) {
      throw new ProofError(usage(), 2);
    }
    const value = argv[index + 1];
    if (value.startsWith("--") || flags[key] !== undefined) {
      throw new ProofError("Invalid or duplicate command option", 2);
    }
    flags[key] = value;
    index += 1;
  }
  return { command, flags };
}

function usage(): string {
  return [
    "Usage:",
    "  npm run paypal:proof -- create --shop DEMO_PHONE_WORKSHOP --amount 1.00 --currency EUR --reference proof-2026-11-06-a --request-id UUID",
    "  npm run paypal:proof -- inspect --reference proof-2026-11-06-a",
    "  npm run paypal:proof -- capture --reference proof-2026-11-06-a --request-id UUID --confirm-human-approved",
    "Use EUR sandbox test amounts only; buyer approval must happen manually in PayPal Sandbox",
  ].join("\n");
}

function requiredString(flags: CliArgs["flags"], name: string): string {
  const value = flags[`--${name}`];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProofError(`Missing required option --${name}`, 2);
  }
  return value.trim();
}

function checkAllowedFlags(args: CliArgs, allowed: string[]): void {
  const accepted = new Set([...allowed.map((flag) => `--${flag}`)]);
  if (args.command === "capture") accepted.add("--confirm-human-approved");
  for (const key of Object.keys(args.flags)) {
    if (!accepted.has(key)) throw new ProofError("Unknown command option", 2);
  }
}

function isRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validateReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/.test(value)) {
    throw new ProofError("Reference must be 3–100 safe ASCII characters", 2);
  }
  return value;
}

function validateAmount(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new ProofError("Amount must be a positive EUR amount with at most two decimals", 2);
  }
  const [whole, fraction = ""] = value.split(".");
  const normalized = `${whole}.${fraction.padEnd(2, "0")}`;
  if (normalized === "0.00") throw new ProofError("Amount must be greater than zero", 2);
  return normalized;
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function shopConfig(env: NodeJS.ProcessEnv, shopRef: ShopRef) {
  const clientId = env[`PAYPAL_CLIENT_ID_${shopRef}`]?.trim();
  const clientSecret = env[`PAYPAL_CLIENT_SECRET_${shopRef}`]?.trim();
  const merchantId = env[`${shopRef}_PAYPAL_MERCHANT_ID`]?.trim();
  if (!clientId || !clientSecret || !merchantId || !/^[2-9A-HJ-NP-Z]{13}$/.test(merchantId)) {
    throw new ProofError(`Missing sandbox configuration for ${shopRef}`, 2);
  }
  return { clientId, clientSecret, merchantId };
}

function assertNoDuplicateSellerMappings(env: NodeJS.ProcessEnv): void {
  const checks = [
    ["PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP", "PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP"],
    ["DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID", "DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID"],
  ];
  for (const [firstName, secondName] of checks) {
    const first = env[firstName]?.trim();
    const second = env[secondName]?.trim();
    if (first && second && first === second) {
      throw new ProofError(`Duplicate seller mapping: ${firstName}, ${secondName}`, 2);
    }
  }
}

function assertUuid(value: string): string {
  if (!isRequestId(value)) throw new ProofError("Request ID must be a UUID v4", 2);
  return value.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function assertOrderMatches(order: Order, record: ProofRecord): void {
  const units = order.purchaseUnits ?? [];
  const unit = units[0];
  if (
    order.id !== record.orderId &&
    record.orderId !== undefined
  ) {
    throw new ProofError("PayPal order ID did not match the saved proof record");
  }
  if (
    order.intent !== CheckoutPaymentIntent.Capture ||
    units.length !== 1 ||
    !unit ||
    unit.referenceId !== record.reference ||
    unit.customId !== record.reference ||
    unit.payee?.merchantId !== record.merchantId ||
    unit.amount?.currencyCode !== record.currency ||
    unit.amount?.value !== record.amount
  ) {
    throw new ProofError("PayPal order did not match the saved amount, seller, and reference");
  }
}

function approvedUrl(order: Order): string {
  const link = order.links?.find(
    (entry) => entry.rel === "approve" || entry.rel === "payer-action",
  );
  if (typeof link?.href !== "string") {
    throw new ProofError("PayPal did not return an approval link");
  }
  try {
    const url = new URL(link.href);
    if (
      url.origin !== "https://www.sandbox.paypal.com" ||
      url.pathname !== "/checkoutnow" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.searchParams.size !== 1 ||
      url.searchParams.get("token") !== order.id
    ) {
      throw new Error("invalid approval link");
    }
    return url.toString();
  } catch {
    throw new ProofError("PayPal returned a non-sandbox or invalid approval link");
  }
}

function assertCompletedCapture(order: Order, record: ProofRecord): string {
  assertOrderMatches(order, record);
  if (order.status !== OrderStatus.Completed) {
    throw new ProofError("PayPal order is not COMPLETED");
  }
  const captures = order.purchaseUnits?.[0]?.payments?.captures ?? [];
  if (captures.length !== 1) {
    throw new ProofError("PayPal order does not contain exactly one capture");
  }
  const capture = captures[0];
  if (
    capture.status !== "COMPLETED" ||
    capture.amount?.currencyCode !== record.currency ||
    capture.amount?.value !== record.amount ||
    typeof capture.id !== "string" ||
    capture.id.length === 0
  ) {
    throw new ProofError("PayPal capture did not match the saved amount and currency");
  }
  return capture.id;
}

async function ensurePrivateStateDir(stateDir: string): Promise<void> {
  const localDir = dirname(stateDir);
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const localStat = await lstat(localDir);
  if (localStat.isSymbolicLink() || !localStat.isDirectory()) {
    throw new ProofError("Local proof state path is not a private directory");
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateStat = await lstat(stateDir);
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new ProofError("Local proof state path is not a private directory");
  }
  await chmod(stateDir, 0o700);
}

async function withStateLock<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  await ensurePrivateStateDir(stateDir);
  const lockPath = resolve(stateDir, "proof.lock");
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ProofError("Another PayPal proof command is active, or a stale lock needs review");
  }
  try {
    await lockHandle.writeFile(`${process.pid}\n`);
    await lockHandle.sync();
    return await action();
  } finally {
    await lockHandle.close();
    await rm(lockPath, { force: true });
  }
}

function isValidSavedPayload(value: unknown, record: ProofRecord): boolean {
  const payload = asRecord(value);
  const units = payload.purchaseUnits;
  if (payload.intent !== "CAPTURE" || !Array.isArray(units) || units.length !== 1) {
    return false;
  }
  const unit = asRecord(units[0]);
  const amount = asRecord(unit.amount);
  const payee = asRecord(unit.payee);
  const paymentSource = asRecord(payload.paymentSource);
  const paypal = asRecord(paymentSource.paypal);
  const experienceContext = asRecord(paypal.experienceContext);
  try {
    return (
      unit.referenceId === record.reference &&
      unit.customId === record.reference &&
      payee.merchantId === record.merchantId &&
      amount.value === record.amount &&
      amount.currencyCode === record.currency &&
      typeof experienceContext.returnUrl === "string" &&
      isHttpsOrigin(new URL(experienceContext.returnUrl).origin) &&
      typeof experienceContext.cancelUrl === "string" &&
      isHttpsOrigin(new URL(experienceContext.cancelUrl).origin)
    );
  } catch {
    return false;
  }
}

function validateJournal(value: unknown, now: number): ProofJournal {
  const parsed = asRecord(value);
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new ProofError("Proof journal format is invalid; preserve it for review");
  }
  const records = parsed.records as unknown[];
  const references = new Set<string>();
  const requestIds = new Set<string>();
  const allowedKeys = new Set([
    "reference", "shopRef", "merchantId", "amount", "currency",
    "createRequestId", "createCreatedAt", "createPayload", "createHttpStatus",
    "createState", "orderId", "lastGetHttpStatus", "captureRequestId",
    "captureStartedAt", "captureHttpStatus", "captureState", "captureId",
  ]);
  for (const entry of records) {
    const raw = asRecord(entry);
    const record = raw as unknown as ProofRecord;
    const valid =
      Object.keys(raw).every((key) => allowedKeys.has(key)) &&
      typeof record.reference === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/.test(record.reference) &&
      SHOP_REFS.includes(record.shopRef) &&
      typeof record.merchantId === "string" && /^[2-9A-HJ-NP-Z]{13}$/.test(record.merchantId) &&
      typeof record.amount === "string" && /^\d+\.\d{2}$/.test(record.amount) && record.amount !== "0.00" &&
      record.currency === AMOUNT_CURRENCY &&
      isRequestId(record.createRequestId) &&
      Number.isSafeInteger(record.createCreatedAt) && record.createCreatedAt > 0 && record.createCreatedAt <= now &&
      isValidSavedPayload(record.createPayload, record) &&
      ["pending", "created", "completed"].includes(record.createState) &&
      (record.orderId === undefined || (typeof record.orderId === "string" && /^[A-Z0-9-]{5,64}$/.test(record.orderId))) &&
      (record.createState === "pending" || record.orderId !== undefined) &&
      (record.createHttpStatus === undefined || (Number.isInteger(record.createHttpStatus) && record.createHttpStatus >= 100 && record.createHttpStatus <= 599)) &&
      (record.lastGetHttpStatus === undefined || (Number.isInteger(record.lastGetHttpStatus) && record.lastGetHttpStatus >= 100 && record.lastGetHttpStatus <= 599)) &&
      (record.captureRequestId === undefined || isRequestId(record.captureRequestId)) &&
      (record.captureStartedAt === undefined || (Number.isSafeInteger(record.captureStartedAt) && record.captureStartedAt > 0 && record.captureStartedAt <= now)) &&
      ((record.captureRequestId === undefined) === (record.captureStartedAt === undefined)) &&
      (record.captureRequestId === undefined || record.captureRequestId !== record.createRequestId) &&
      (record.captureHttpStatus === undefined || (Number.isInteger(record.captureHttpStatus) && record.captureHttpStatus >= 100 && record.captureHttpStatus <= 599)) &&
      (record.captureState === undefined || ["pending", "completed", "observed"].includes(record.captureState)) &&
      (record.captureRequestId === undefined ? record.captureStartedAt === undefined : record.captureStartedAt !== undefined && record.captureState !== undefined && record.captureState !== "observed") &&
      (record.captureState !== "completed" || (record.createState === "completed" && record.captureRequestId !== undefined && typeof record.captureId === "string" && /^[A-Za-z0-9-]{5,64}$/.test(record.captureId))) &&
      (record.captureState !== "observed" || (record.createState === "completed" && record.captureRequestId === undefined && typeof record.captureId === "string" && /^[A-Za-z0-9-]{5,64}$/.test(record.captureId))) &&
      (record.createState !== "completed" || record.captureState === "completed" || record.captureState === "observed") &&
      (record.captureId === undefined || (typeof record.captureId === "string" && /^[A-Za-z0-9-]{5,64}$/.test(record.captureId)));
    if (!valid || references.has(record.reference)) {
      throw new ProofError("Proof journal contains invalid or duplicate records; preserve it for review");
    }
    if (requestIds.has(record.createRequestId)) {
      throw new ProofError("Proof journal reuses a request UUID; preserve it for review");
    }
    requestIds.add(record.createRequestId);
    if (record.captureRequestId) {
      if (requestIds.has(record.captureRequestId)) {
        throw new ProofError("Proof journal reuses a request UUID; preserve it for review");
      }
      requestIds.add(record.captureRequestId);
    }
    references.add(record.reference);
  }
  return { version: 1, records: records as ProofRecord[] };
}

async function readJournal(stateDir: string, now: number): Promise<ProofJournal> {
  const path = resolve(stateDir, "proof-state.json");
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile()) {
      throw new ProofError("Proof journal is not a regular local file");
    }
    await chmod(path, 0o600);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateJournal(parsed, now);
  } catch (error) {
    if (error instanceof ProofError) throw error;
    if (asRecord(error).code === "ENOENT") return { version: 1, records: [] };
    throw new ProofError("Proof journal could not be read; preserve it for review");
  }
}

async function writeJournal(
  stateDir: string,
  journal: ProofJournal,
  currentTime = Date.now(),
): Promise<void> {
  const destination = resolve(stateDir, "proof-state.json");
  const temporary = resolve(stateDir, `proof-state.${randomUUID()}.tmp`);
  try {
    validateJournal(journal, currentTime);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    const directory = await open(stateDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    await rm(temporary, { force: true });
    throw new ProofError("Proof journal could not be updated safely");
  }
}

function findRecord(journal: ProofJournal, reference: string): ProofRecord {
  const record = journal.records.find((candidate) => candidate.reference === reference);
  if (!record) throw new ProofError("No saved PayPal proof exists for this reference", 2);
  return record;
}

function requestIdUsed(journal: ProofJournal, key: string): boolean {
  return journal.records.some(
    (record) => record.createRequestId === key || record.captureRequestId === key,
  );
}

function apiStatus(error: unknown): number | undefined {
  const value = asRecord(error).statusCode;
  return typeof value === "number" ? value : undefined;
}

function responseOrder(response: { result?: Order }): Order {
  if (!response.result || typeof response.result !== "object") {
    throw new ProofError("PayPal returned an invalid Orders response");
  }
  return response.result;
}

async function getOrderRecorded(
  api: OrdersController,
  record: ProofRecord,
  journal: ProofJournal,
  stateDir: string,
  now: () => number,
): Promise<Order> {
  try {
    const response = await api.getOrder({ id: record.orderId! }, getRequestOptions());
    record.lastGetHttpStatus = response.statusCode;
    await writeJournal(stateDir, journal, now());
    return responseOrder(response);
  } catch (error) {
    if (error instanceof ProofError) throw error;
    const status = apiStatus(error);
    if (status !== undefined) record.lastGetHttpStatus = status;
    await writeJournal(stateDir, journal, now());
    throw new ProofError(`PayPal order lookup failed${status === undefined ? "" : ` (HTTP ${status})`}; no capture was sent`);
  }
}

function getRequestOptions() {
  return { abortSignal: AbortSignal.timeout(API_TIMEOUT_MS) };
}

export async function executeProofCommand(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    now?: () => number;
    log?: (line: string) => void;
    apiFactory?: (clientId: string, clientSecret: string) => OrdersController;
  } = {},
): Promise<number> {
  const args = parseArgs(argv);
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const stateDir = options.stateDir ?? STATE_DIR;
  const now = options.now ?? Date.now;
  const apiFactory = options.apiFactory ?? createOrdersApi;

  if (args.command === "create") {
    checkAllowedFlags(args, ["shop", "amount", "currency", "reference", "request-id"]);
  } else if (args.command === "inspect") {
    checkAllowedFlags(args, ["reference"]);
  } else {
    checkAllowedFlags(args, ["reference", "request-id"]);
    if (args.flags["--confirm-human-approved"] !== true) {
      throw new ProofError("Capture requires --confirm-human-approved after manual buyer approval", 2);
    }
  }

  if (!isHttpsOrigin(env.APP_ORIGIN ?? "")) {
    throw new ProofError("APP_ORIGIN must be an HTTPS origin", 2);
  }

  const requestedRef = args.command === "create"
    ? validateReference(requiredString(args.flags, "reference"))
    : validateReference(requiredString(args.flags, "reference"));

  return withStateLock(stateDir, async () => {
    const journal = await readJournal(stateDir, now());

    if (args.command === "create") {
      const shop = requiredString(args.flags, "shop");
      if (!SHOP_REFS.includes(shop as ShopRef)) {
        throw new ProofError("Unsupported demo shop reference", 2);
      }
      const shopRef = shop as ShopRef;
      assertNoDuplicateSellerMappings(env);
      const amount = validateAmount(requiredString(args.flags, "amount"));
      const currency = requiredString(args.flags, "currency");
      if (currency !== AMOUNT_CURRENCY) {
        throw new ProofError("Only EUR sandbox proof orders are supported", 2);
      }
      const requestId = assertUuid(requiredString(args.flags, "request-id"));
      const seller = shopConfig(env, shopRef);
      const origin = env.APP_ORIGIN!.replace(/\/$/, "");
      const payload: OrderRequest = {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: requestedRef,
            customId: requestedRef,
            description: "AgentShelf sandbox payment proof",
            amount: { currencyCode: currency, value: amount },
            payee: { merchantId: seller.merchantId },
          },
        ],
        paymentSource: {
          paypal: {
            experienceContext: {
              returnUrl: `${origin}/?paypal-proof=return`,
              cancelUrl: `${origin}/?paypal-proof=cancel`,
              userAction: PaypalExperienceUserAction.PayNow,
            },
          },
        },
      };

      let record = journal.records.find((candidate) => candidate.reference === requestedRef);
      if (record) {
        if (
          record.shopRef !== shopRef ||
          record.merchantId !== seller.merchantId ||
          record.amount !== amount ||
          record.currency !== currency ||
          record.createRequestId !== requestId ||
          JSON.stringify(record.createPayload) !== JSON.stringify(payload)
        ) {
          throw new ProofError("Saved reference is immutable; use a new reference and UUID", 2);
        }
        if (!record.orderId && now() - record.createCreatedAt >= IDEMPOTENCY_WINDOW_MS) {
          throw new ProofError("Create result is unresolved beyond the safe retry window; reconcile in PayPal before any new order");
        }
      } else {
        if (requestIdUsed(journal, requestId)) {
          throw new ProofError("Request UUID is already assigned to another proof operation", 2);
        }
        record = {
          reference: requestedRef,
          shopRef,
          merchantId: seller.merchantId,
          amount,
          currency,
          createRequestId: requestId,
          createCreatedAt: now(),
          createPayload: payload,
          createState: "pending",
        };
        journal.records.push(record);
        await writeJournal(stateDir, journal, now());
      }

      const api = apiFactory(seller.clientId, seller.clientSecret);
      if (record.orderId) {
        const order = await getOrderRecorded(api, record, journal, stateDir, now);
        assertOrderMatches(order, record);
        if (order.status === OrderStatus.Completed) {
          record.createState = "completed";
          record.captureId = assertCompletedCapture(order, record);
          record.captureState = record.captureRequestId ? "completed" : "observed";
          await writeJournal(stateDir, journal, now());
          log(`PASS existing order ${record.orderId} is COMPLETED; HTTP ${record.lastGetHttpStatus}`);
          return 0;
        }
        const href = [OrderStatus.Created, OrderStatus.PayerActionRequired].includes(
          order.status as OrderStatus,
        )
          ? approvedUrl(order)
          : undefined;
        log(`PASS existing order ${record.orderId} status ${order.status ?? "UNKNOWN"}; HTTP ${record.lastGetHttpStatus}`);
        if (href) log(`Sandbox buyer approval URL: ${href}`);
        return 0;
      }

      try {
        const response = await api.createOrder(
          { body: payload, paypalRequestId: requestId, prefer: "return=representation" },
          getRequestOptions(),
        );
        record.createHttpStatus = response.statusCode;
        await writeJournal(stateDir, journal, now());
        const order = responseOrder(response);
        if (typeof order.id === "string" && order.id.length > 0) {
          record.orderId = order.id;
          await writeJournal(stateDir, journal, now());
        } else {
          throw new ProofError("PayPal order response did not include an order ID; reconcile before continuing");
        }
        assertOrderMatches(order, record);
        if (
          order.status !== OrderStatus.Created &&
          order.status !== OrderStatus.PayerActionRequired
        ) {
          throw new ProofError("PayPal created an order in an unexpected state; inspect the saved record");
        }
        const href = approvedUrl(order);
        record.createState = "created";
        await writeJournal(stateDir, journal, now());
        log(`PASS created sandbox order ${order.id} for ${shopRef}, HTTP ${response.statusCode}, ${record.amount} ${record.currency}; status ${order.status}`);
        log(`Sandbox buyer approval URL: ${href}`);
        log("The buyer must approve this order manually in PayPal Sandbox; no capture has been sent");
        return 0;
      } catch (error) {
        if (error instanceof ProofError) throw error;
        const status = apiStatus(error);
        if (status !== undefined) record.createHttpStatus = status;
        await writeJournal(stateDir, journal, now());
        throw new ProofError(
          `Create result is unresolved${status === undefined ? "" : ` (HTTP ${status})`}; repeat only the exact command with the same UUID within six hours, or reconcile in PayPal`,
        );
      }
    }

    const record = findRecord(journal, requestedRef);
    assertNoDuplicateSellerMappings(env);
    const seller = shopConfig(env, record.shopRef);
    if (seller.merchantId !== record.merchantId) {
      throw new ProofError("Saved seller mapping no longer matches configuration; no PayPal request was sent");
    }
    if (!record.orderId) {
      throw new ProofError("PayPal has not returned an order ID; resolve the saved create request before continuing");
    }
    const api = apiFactory(seller.clientId, seller.clientSecret);
    const order = await getOrderRecorded(api, record, journal, stateDir, now);
    assertOrderMatches(order, record);

    if (args.command === "inspect") {
      if (order.status === OrderStatus.Completed) {
        const captureId = assertCompletedCapture(order, record);
        record.createState = "completed";
        record.captureState = record.captureRequestId ? "completed" : "observed";
        record.captureId = captureId;
        await writeJournal(stateDir, journal, now());
        log(`PASS order ${record.orderId} is COMPLETED; capture ${captureId}; HTTP ${record.lastGetHttpStatus}; ${record.amount} ${record.currency}`);
      } else {
        log(`PASS order ${record.orderId} status ${order.status ?? "UNKNOWN"}; HTTP ${record.lastGetHttpStatus}; expected ${record.amount} ${record.currency}; seller ${record.shopRef}`);
        if (order.status === OrderStatus.Approved) {
          log("PayPal reports buyer approval; a server-side capture may now be requested explicitly");
        }
      }
      return 0;
    }

    if (order.status === OrderStatus.Completed) {
      const captureId = assertCompletedCapture(order, record);
      record.createState = "completed";
      record.captureState = record.captureRequestId ? "completed" : "observed";
      record.captureId = captureId;
      await writeJournal(stateDir, journal, now());
      log(`PASS order ${record.orderId} is already COMPLETED; capture ${captureId}; HTTP ${record.lastGetHttpStatus}`);
      return 0;
    }
    if (order.status !== OrderStatus.Approved) {
      throw new ProofError("PayPal order is not APPROVED; capture was not sent");
    }

    const requestId = assertUuid(requiredString(args.flags, "request-id"));
    if (record.captureRequestId && record.captureRequestId !== requestId) {
      throw new ProofError("Capture UUID is immutable; retry only with the saved UUID", 2);
    }
    if (
      record.captureRequestId &&
      record.captureStartedAt !== undefined &&
      now() - record.captureStartedAt >= IDEMPOTENCY_WINDOW_MS
    ) {
      throw new ProofError("Capture result is unresolved beyond the safe retry window; reconcile in PayPal before any new capture");
    }
    if (!record.captureRequestId) {
      if (requestId === record.createRequestId || requestIdUsed(journal, requestId)) {
        throw new ProofError("Capture UUID is already assigned to another proof operation", 2);
      }
      record.captureRequestId = requestId;
      record.captureStartedAt = now();
      record.captureState = "pending";
      await writeJournal(stateDir, journal, now());
    }

    try {
      const captureResponse = await api.captureOrder(
        { id: record.orderId, paypalRequestId: requestId, body: {} },
        getRequestOptions(),
      );
      record.captureHttpStatus = captureResponse.statusCode;
      await writeJournal(stateDir, journal, now());
    } catch (error) {
      // A timed-out capture may still have completed. Reconcile with PayPal before reporting.
      const status = apiStatus(error);
      if (status !== undefined) record.captureHttpStatus = status;
      await writeJournal(stateDir, journal, now());
    }
    let reconciled: Order;
    try {
      reconciled = await getOrderRecorded(api, record, journal, stateDir, now);
      assertOrderMatches(reconciled, record);
    } catch {
      throw new ProofError("Capture outcome is uncertain; inspect the saved order and retry only with the same UUID");
    }
    const captureId = assertCompletedCapture(reconciled, record);
    record.createState = "completed";
    record.captureState = "completed";
    record.captureId = captureId;
    await writeJournal(stateDir, journal, now());
    log(`PASS captured sandbox order ${record.orderId}; capture ${captureId}; HTTP ${record.captureHttpStatus ?? "n/a"} (GET ${record.lastGetHttpStatus}); ${record.amount} ${record.currency}`);
    return 0;
  });
}

async function main(argv: string[]): Promise<void> {
  try {
    process.exitCode = await executeProofCommand(argv);
  } catch (error) {
    if (error instanceof ProofError) {
      const message = error.message;
      console.error(message);
      process.exitCode = error.exitCode;
      return;
    }
    // Do not print SDK errors, stack traces, request URLs, credentials, or API response bodies.
    console.error("PayPal proof failed; provider and internal details were suppressed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2));
}
