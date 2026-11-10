# Design direction

The direction for every AgentShelf screen, in the five lines the [unslop skill](../.agents/skills/unslop/SKILL.md) asks for. UI work follows that skill and this file, so the seller screens and the storefront read as one product. To change the direction, change it here.

- **Product.** Small shops with no online store get a catalog that buyers' assistants can search and buy from. A seller corrects it from a photo of their price list, takes bookings and sees what people asked for
- **Character.** Exact, plain-spoken, handy
- **World.** The counter of a repair workshop: receipt books with carbon copies, handwritten price lists, a repair diary
- **Moments.** The seller's own photo next to the table being checked, the day's repairs in the scheduler, and the list of what people searched for and could not find. On the homepage, one sale told in three panels: the shop owner's assistant changing a record, the record AgentShelf keeps, and a buyer's assistant selling from it
- **Signature.** Carbon-blue text for words that came from outside the system: what the price list says, what a buyer's assistant searched for. One detail, used only for that

## What this means on a screen

- **Surfaces and text** use the zinc ramp, and never take a tint from the world.
- **One light theme.** The page is a white sheet whatever the system prefers. The `dark:` utilities left in the markup answer only to a `.dark` class, which nothing sets. The one exception is the top of the homepage: the header, the headline and the opening scene sit on a `zinc-950` band, and the scene's three panels stay white sheets on it.
- **`ink` (`#0070ba`)** is the one accent, for the main action, the selection and the signature. **`blocked`**, **`doubt`** and **`accepted`** carry meaning only, and always come with words, so color is never the only signal.
- **Action shape:** the homepage's first action uses a 24px radius, matching the pill of the Log in with PayPal button, and takes the band's light tone, so it does not read as a second PayPal button beside PayPal's own `#0070BA`.
- **Homepage:** a left-aligned headline that says both sides work through an assistant and AgentShelf keeps the deal exact, two actions, and the opening scene on the demo workshop's own data. Below it, in order: what an assistant could get wrong and the rule that prevents it, the payments that already went through, the price list becoming a catalog, what the owner can look at, who can pay, and the connector. The dashboard opens on six widgets, each a sheet with one hairline, and payment status leads as four totals in a row. Arranging opens on the dashboard itself, with Studio's panels closed until the seller opens one to add a filter or a chart.
- **Type** is Geist Sans, in sentence case, with `tabular-nums` on every amount.
- **Motion:** in the seller screens, the line passing over a photo while it is being read is the one thing that moves by itself. On the homepage the opening scene plays once, in the order the sale happens, and can be played again; each section below enters once when the reader reaches it, and a held slot turns into a confirmed one once. Nothing loops, every element rests in its final state, and all of it stops for people who ask for reduced motion.

Tokens are in [`globals.css`](../src/app/globals.css).
