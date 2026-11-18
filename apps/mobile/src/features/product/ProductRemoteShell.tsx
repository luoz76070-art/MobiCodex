import { useBackLayer } from "../../shared/BackLayers";
import { useEffect, useState, type ReactNode } from "react";
import { productBeforeNavigate, productOpenUpdates } from "./host";
import { ProductUpdatesPage } from "./ProductUpdatesPage";
import { startStandaloneAppearance } from "./standalone";

/** The app frame: follows the system appearance, hosts the update page and shows an optional notice below the content. */
export function ProductRemoteShell({ children, notice }: { children: ReactNode; notice?: ReactNode }) {
  const [updates, setUpdates] = useState(false);
  useEffect(() => startStandaloneAppearance(), []);
  useEffect(() => {
    const open = () => {
      if (window.dispatchEvent(new Event(productBeforeNavigate, { cancelable: true }))) setUpdates(true);
    };
    window.addEventListener(productOpenUpdates, open);
    return () => { window.removeEventListener(productOpenUpdates, open); };
  }, [updates]);
  useBackLayer(updates, () => leaveUpdates(), 300);
  function leaveUpdates() {
    if (window.dispatchEvent(new Event(productBeforeNavigate, { cancelable: true }))) setUpdates(false);
  }
  return <div className="product-remote-shell product-standalone">
    <div className="product-remote-content">{updates ? <ProductUpdatesPage onBack={leaveUpdates} /> : children}</div>
    {notice}
  </div>;
}
