import { describe, expect, it } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createShop } from "../../../test/fixtures";
import { hashAccessCode } from "./access-code";
import {
  readSellerSession,
  requireSellerShop,
  signInSeller,
} from "./seller-session";

const getDb = setupMigratedDatabase();

const shopWithCode = async (code: string) =>
  createShop(getDb(), { sellerAccessCodeHash: await hashAccessCode(code) });

const unauthorized = { code: "UNAUTHORIZED" };

describe("signing in", () => {
  it("grants a session for the shop whose code was given", async () => {
    const shop = await shopWithCode("code-for-shop-a");
    await shopWithCode("code-for-shop-b");

    const session = await signInSeller(getDb(), {
      shopSlug: shop.slug,
      accessCode: "code-for-shop-a",
    });

    expect(session.shopId).toBe(shop.id);
    const resolved = await requireSellerShop(getDb(), session.token);
    expect(resolved.id).toBe(shop.id);
  });

  it("returns no credential columns with the shop", async () => {
    const shop = await shopWithCode("code-for-shop-a");
    const { token } = await signInSeller(getDb(), {
      shopSlug: shop.slug,
      accessCode: "code-for-shop-a",
    });
    const resolved = await requireSellerShop(getDb(), token);
    expect(Object.keys(resolved).sort()).toEqual([
      "currency",
      "id",
      "name",
      "sessionExpiresAt",
      "slug",
      "timezone",
    ]);
  });

  it("does not grant access for selecting a shop", async () => {
    const shop = await shopWithCode("code-for-shop-a");
    await expect(
      signInSeller(getDb(), { shopSlug: shop.slug }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a wrong code and another shop's code", async () => {
    const shop = await shopWithCode("code-for-shop-a");
    await shopWithCode("code-for-shop-b");
    for (const accessCode of ["wrong", "code-for-shop-b"]) {
      await expect(
        signInSeller(getDb(), { shopSlug: shop.slug, accessCode }),
      ).rejects.toMatchObject(unauthorized);
    }
  });

  it("rejects an unknown shop and a shop with no code configured", async () => {
    const noCode = await createShop(getDb(), { sellerAccessCodeHash: null });
    for (const shopSlug of ["no-such-shop", noCode.slug]) {
      await expect(
        signInSeller(getDb(), { shopSlug, accessCode: "anything" }),
      ).rejects.toMatchObject(unauthorized);
    }
  });

  it("does not accept a shop identifier in the sign-in request", async () => {
    const shop = await shopWithCode("code-for-shop-a");
    await expect(
      signInSeller(getDb(), {
        shopSlug: shop.slug,
        accessCode: "code-for-shop-a",
        shopId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("using a session", () => {
  const signedInSession = async () => {
    const shop = await shopWithCode("code-for-shop-a");
    const session = await signInSeller(getDb(), {
      shopSlug: shop.slug,
      accessCode: "code-for-shop-a",
    });
    return { shop, ...session };
  };

  it.each([undefined, "", "garbage", "a.b", "a.b.c"])(
    "rejects the token %j",
    async (token) => {
      await expect(requireSellerShop(getDb(), token)).rejects.toMatchObject(
        unauthorized,
      );
    },
  );

  it("cannot be pointed at another shop by editing the token", async () => {
    const { token } = await signedInSession();
    const victim = await shopWithCode("code-for-shop-b");
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        shopId: victim.id,
      }),
    ).toString("base64url");

    await expect(
      requireSellerShop(getDb(), `${forged}.${signature}`),
    ).rejects.toMatchObject(unauthorized);
  });

  it("cannot be extended by editing the token", async () => {
    const { token, expiresAt } = await signedInSession();
    const [payload, signature] = token.split(".");
    const extended = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        exp: expiresAt.getTime() + 1_000_000,
      }),
    ).toString("base64url");
    expect(readSellerSession(`${extended}.${signature}`)).toBeNull();
  });

  it("expires", async () => {
    const { token, expiresAt } = await signedInSession();
    expect(readSellerSession(token, new Date(expiresAt.getTime() - 1))).not.toBe(
      null,
    );
    await expect(
      requireSellerShop(getDb(), token, expiresAt),
    ).rejects.toMatchObject(unauthorized);
  });
});
