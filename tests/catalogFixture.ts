import catalogJson from "../config/band-catalog.example.json";
import { validateBandCatalog } from "../src/shared/settings";
import type { BandCatalog } from "../src/shared/types";

export const TEST_CATALOG = validateBandCatalog(catalogJson as BandCatalog);
export const STARTRACK_BAND = TEST_CATALOG.bands.find((band) => band.id === "startrack-410-470")!;
export const FOUR_DX_BAND = TEST_CATALOG.bands.find((band) => band.id === "4dx-902400-927600")!;
export const GNSS_BANDS = TEST_CATALOG.bands.filter((band) => band.service === "gnss");
