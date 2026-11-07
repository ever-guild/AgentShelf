import { PAGE_COLUMN, SECONDARY_TEXT } from "../shop-parts";

export default function ShopNotFound() {
  return (
    <div className={`${PAGE_COLUMN} gap-3`}>
      <h1 className="text-3xl font-medium text-balance">We cannot find that shop or product</h1>
      <p className={`max-w-prose text-pretty ${SECONDARY_TEXT}`}>
        It is not on sale here. Check the link you were given, or ask the shop for a new one.
      </p>
    </div>
  );
}
