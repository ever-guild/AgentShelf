import { describe, expect, it } from "vitest";

import { readablePayPalCountry, suggestShopLocation } from "./shop-location";

describe("PayPal shop-location suggestions", () => {
  it("formats ISO country codes as readable English names", () => {
    expect(readablePayPalCountry("LV")).toBe("Latvia");
    expect(readablePayPalCountry("Latvia")).toBe("Latvia");
    expect(readablePayPalCountry("ZZ")).toBe("ZZ");
    expect(readablePayPalCountry("XX")).toBe("XX");
  });

  it("uses whichever city and country values are available", () => {
    expect(suggestShopLocation("", "Liepāja", "LV")).toBe("Liepāja, Latvia");
    expect(suggestShopLocation("", "Riga", null)).toBe("Riga");
    expect(suggestShopLocation("", null, "LV")).toBe("Latvia");
    expect(suggestShopLocation("", null, null)).toBe("");
  });

  it("keeps an existing shop location and bounds unusually long profile values", () => {
    expect(suggestShopLocation("My chosen location", "Riga", "LV")).toBe("My chosen location");

    const country = "Country".repeat(8);
    const suggestion = suggestShopLocation("", "a".repeat(128), country);
    expect(suggestion.length).toBeLessThanOrEqual(160);
    expect(suggestion.endsWith(`, ${country}`)).toBe(true);
  });
});
