// A custom button built to PayPal's Button design guide
// (https://developer.paypal.com/log-in/designer-guide/): the white label and the white PayPal
// monogram on #0070BA, a pill, 24 px side padding, an 18 px mark and a 9 px gap. PayPal's hosted
// button image is only 211 × 48 pixels and may not be self-hosted, so it blurs on high-density
// screens. The guide forbids changing the background of the coloured version, so the blue stays
// in dark mode too.

// PayPal's white monogram, unmodified, from
// https://www.paypalobjects.com/paypal-ui/logos/svg/paypal-mark-monotone.svg, with the view box
// set to the mark's own bounds.
function PayPalMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="6.15 3 37.5 45"
      className="h-[18px] w-[15px] shrink-0"
    >
      <path
        fill="#fff"
        fillRule="evenodd"
        clipRule="evenodd"
        opacity=".95"
        d="M38.168 13.352c-1.596-.842-3.535-1.346-5.644-1.346h-12.6l-4.218 26.92H6.413L12 3.032h15.05c5.065 0 9.056 2.827 10.518 6.755a9.643 9.643 0 0 1 .6 3.565Z"
      />
      <path
        fill="#fff"
        opacity=".45"
        d="M43.527 23.671A12.848 12.848 0 0 1 30.814 34.44h-5.188L23.459 47.9h-9.235l1.482-8.973 1.747-11.148.363-2.312h7.468c7.753 0 12.884-6.562 12.884-12.114l.005.002c3.817 1.964 6.038 5.944 5.354 10.317Z"
      />
      <path
        fill="#fff"
        opacity=".7"
        d="M38.167 13.352c-1.596-.841-3.534-1.346-5.644-1.346H19.924l-2.11 13.46h7.47c7.752 0 12.883-6.562 12.883-12.114Z"
      />
    </svg>
  );
}

export function PayPalLoginButton() {
  return (
    <a
      href="/api/seller/identity/paypal/start"
      className="inline-flex h-12 shrink-0 items-center gap-[9px] rounded-full bg-[#0070ba] px-6 text-base/6 font-medium whitespace-nowrap text-white transition-[background-color,transform] hover:bg-[#0070ba]/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:scale-[0.98]"
    >
      <PayPalMark />
      Log in with PayPal
    </a>
  );
}
