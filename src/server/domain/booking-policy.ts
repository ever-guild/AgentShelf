// The demo's booking policy, in one place. docs/architecture.md explains each choice. A deposit has
// no setting here: it is the amount each service states, in products.deposit_minor, and the rest of
// the service's price is paid at the shop.
export const BOOKING_POLICY = {
  // How long an unpaid hold keeps a slot from its creation. A buyer needs time to open PayPal and
  // approve, and everyone else is waiting for the slot meanwhile.
  holdMinutes: 15,
  // Slots start this far apart, counted from the start of a working window.
  slotStepMinutes: 30,
  // A slot closer than this is not offered. It must be longer than a hold, so that a hold always
  // runs out before its appointment starts.
  minLeadMinutes: 60,
  // How many slots one get_slots answer carries.
  maxSlotsPerAnswer: 100,
} as const;
