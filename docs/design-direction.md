# Design direction

The direction for every AgentShelf screen, in the five lines the [unslop skill](../.agents/skills/unslop/SKILL.md) asks for. UI work follows that skill and this file, so the seller screens and the storefront read as one product. To change the direction, change it here.

- **Product.** Small shops with no online store get a catalog that buyers' assistants can search and buy from. A seller corrects it from a photo of their price list, takes bookings and sees what people asked for
- **Character.** Exact, plain-spoken, handy
- **World.** The counter of a repair workshop: receipt books with carbon copies, handwritten price lists, a repair diary
- **Moments.** The seller's own photo next to the table being checked, the day's repairs in the scheduler, and the list of what people searched for and could not find. On the homepage, the demo workshop's price list, the catalog it becomes and one order through a buyer's assistant, side by side
- **Signature.** Carbon-blue text for words that came from outside the system: what the price list says, what a buyer's assistant searched for. One detail, used only for that

## What this means on a screen

- **Surfaces and text** use the zinc ramp, and never take a tint from the world.
- **One light theme.** The page is a white sheet whatever the system prefers. The `dark:` utilities left in the markup answer only to a `.dark` class, which nothing sets.
- **`ink` (`#0070ba`)** is the one accent, for the main action, the selection and the signature. **`blocked`**, **`doubt`** and **`accepted`** carry meaning only, and always come with words, so color is never the only signal.
- **Action shape:** the homepage demo action uses a 24px radius, matching the pill of the Log in with PayPal button, and takes the text color, so it does not read as a second PayPal button beside PayPal's own `#0070BA`.
- **Homepage:** one centered column with a headline that says what the service is, two actions, and the three steps shown on the demo workshop's own data. The dashboard opens on six widgets, each a sheet with one hairline, and payment status leads as four totals in a row. Arranging opens on the dashboard itself, with Studio's panels closed until the seller opens one to add a filter or a chart.
- **Type** is Geist Sans, in sentence case, with `tabular-nums` on every amount.
- **Motion:** the line passing over a photo while it is being read is the one thing that moves by itself, and it stops for people who ask for reduced motion.

Tokens are in [`globals.css`](../src/app/globals.css).
