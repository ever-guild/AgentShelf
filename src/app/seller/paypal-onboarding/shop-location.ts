export const SHOP_LOCATION_MAX_LENGTH = 160;

export function readablePayPalCountry(country: string | null | undefined): string {
  const value = country?.trim() ?? "";
  if (!/^[a-z]{2}$/i.test(value)) return value;

  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(value.toUpperCase());
    if (name && name.toUpperCase() !== value.toUpperCase() && name !== "Unknown Region") return name;
  } catch {
    // Keep the provider value if the runtime cannot format region names.
  }
  return value;
}

export function suggestShopLocation(
  current: string,
  city: string | null | undefined,
  country: string | null | undefined,
): string {
  if (current.length > 0) return current;

  const suggestedCity = city?.trim() ?? "";
  const suggestedCountry = readablePayPalCountry(country);
  if (!suggestedCity) return suggestedCountry.slice(0, SHOP_LOCATION_MAX_LENGTH);
  if (!suggestedCountry) return suggestedCity.slice(0, SHOP_LOCATION_MAX_LENGTH);

  const cityLimit = SHOP_LOCATION_MAX_LENGTH - suggestedCountry.length - 2;
  if (cityLimit <= 0) return suggestedCountry.slice(0, SHOP_LOCATION_MAX_LENGTH);
  return `${suggestedCity.slice(0, cityLimit)}, ${suggestedCountry}`;
}
