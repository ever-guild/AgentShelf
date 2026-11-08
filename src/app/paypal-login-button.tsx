import Image from "next/image";

const PAYPAL_LOGIN_BUTTON_IMAGE =
  "https://www.paypalobjects.com/devdoc/log-in-with-paypal-button.png";

export function PayPalLoginButton() {
  return (
    <a
      href="/api/seller/identity/paypal/start"
      className="inline-flex h-12 w-[211px] items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <Image
        src={PAYPAL_LOGIN_BUTTON_IMAGE}
        alt="Log in with PayPal"
        width={211}
        height={48}
        unoptimized
      />
    </a>
  );
}
