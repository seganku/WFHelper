import { parseTradedItemName } from "../config/shared/tradeItemName";
import * as wfmCatalog from "./wfmCatalog";

export function lookupTradedCatalogItem(
  displayName: string,
): ReturnType<typeof wfmCatalog.lookupByName> {
  const { baseName } = parseTradedItemName(displayName);
  if (!baseName) return null;
  return (
    wfmCatalog.lookupByName(baseName) ||
    wfmCatalog.lookupByName(baseName.replace(/ Blueprint$/i, ""))
  );
}
