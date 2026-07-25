import { describe, it, expect } from "vitest";
import {
  JIOBP_ENDPOINT,
  JIOBP_MOBILE_NUMBER,
  JIOBP_IMEI_NO,
  buildROMasterRequest,
  buildFindFuelStationRequest,
  parseROMasterResponse,
  parseFindFuelStationResponse,
} from "./jiobp.js";

describe("buildROMasterRequest", () => {
  it("builds a well-formed ROMaster request with the given token", () => {
    const result = buildROMasterRequest("test-token-123");

    expect(result.url).toBe(JIOBP_ENDPOINT);
    expect(result.method).toBe("POST");
    expect(result.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(result.body);
    expect(body).toEqual({
      CustomerRequest: {
        ROMaster: {
          IMEINo: "AE3A.240806.043",
          MobileNumber: "9028833886",
          TokenNumber: "test-token-123",
        },
      },
    });
  });
});

describe("buildFindFuelStationRequest", () => {
  it("builds a well-formed FindFuelStation request with codes and token", () => {
    const result = buildFindFuelStationRequest(["MHC117", "MHF175"], "test-token-456");

    expect(result.url).toBe(JIOBP_ENDPOINT);
    expect(result.method).toBe("POST");

    const body = JSON.parse(result.body);
    expect(body).toEqual({
      CustomerRequest: {
        FuelStation: {
          FindFuelStation: {
            FuelStations: [{ FuelStationCode: "MHC117" }, { FuelStationCode: "MHF175" }],
            IMEINo: "AE3A.240806.043",
            MobileNumber: "9028833886",
            TokenNumber: "test-token-456",
            SearchFlag: "R",
            State: "",
          },
        },
      },
    });
  });
});

describe("parseROMasterResponse", () => {
  it("ok: parses a real 3-station index sample", () => {
    const json = {
      CustomerResponse: {
        MasterData: {
          ResponseFlag: "S",
          ResponseMsg: "Successful",
          TokenNumber: "6fd73e38-ffb0-1818-a066-e830d49f23ff",
          FetchROMaster: {
            ROMasterData: [
              { FuelStationCode: "UTF003", Lattitude: "29.136124", Longitude: "79.521523", State: "Uttarakhand" },
              { FuelStationCode: "UWF030", Lattitude: "28.795584", Longitude: "77.535108", State: "Uttar Pradesh" },
              { FuelStationCode: "KLF009", Lattitude: "9.64721", Longitude: "76.54767", State: "Kerala" },
            ],
          },
        },
      },
    };

    const result = parseROMasterResponse(json);

    expect(result).toEqual([
      { fuelStationCode: "UTF003", lat: 29.136124, lng: 79.521523, state: "Uttarakhand" },
      { fuelStationCode: "UWF030", lat: 28.795584, lng: 77.535108, state: "Uttar Pradesh" },
      { fuelStationCode: "KLF009", lat: 9.64721, lng: 76.54767, state: "Kerala" },
    ]);
  });

  it("skips entries with missing FuelStationCode or non-finite coordinates", () => {
    const json = {
      CustomerResponse: {
        MasterData: {
          FetchROMaster: {
            ROMasterData: [
              { Lattitude: "29.136124", Longitude: "79.521523", State: "Uttarakhand" }, // missing FuelStationCode
              { FuelStationCode: "UWF030", Lattitude: "not-a-number", Longitude: "77.535108", State: "Uttar Pradesh" }, // bad lat
              { FuelStationCode: "KLF009", Lattitude: "9.64721", Longitude: "76.54767", State: "Kerala" }, // valid
            ],
          },
        },
      },
    };

    const result = parseROMasterResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      fuelStationCode: "KLF009",
      lat: 9.64721,
      lng: 76.54767,
      state: "Kerala",
    });
  });

  it("returns [] for malformed/empty input", () => {
    expect(parseROMasterResponse(null)).toEqual([]);
    expect(parseROMasterResponse(undefined)).toEqual([]);
    expect(parseROMasterResponse({})).toEqual([]);
    expect(parseROMasterResponse({ CustomerResponse: {} })).toEqual([]);
    expect(parseROMasterResponse("not an object")).toEqual([]);
    expect(
      parseROMasterResponse({
        CustomerResponse: { MasterData: { FetchROMaster: { ROMasterData: "not-an-array" } } },
      })
    ).toEqual([]);
  });

  it("state is null when absent or blank", () => {
    const json = {
      CustomerResponse: {
        MasterData: {
          FetchROMaster: {
            ROMasterData: [
              { FuelStationCode: "UTF003", Lattitude: "29.136124", Longitude: "79.521523" }, // no State field
              { FuelStationCode: "UWF030", Lattitude: "28.795584", Longitude: "77.535108", State: "  " }, // whitespace only
            ],
          },
        },
      },
    };

    const result = parseROMasterResponse(json);

    expect(result).toHaveLength(2);
    expect(result[0]!.state).toBeNull();
    expect(result[1]!.state).toBeNull();
  });
});

describe("parseFindFuelStationResponse", () => {
  it("ok: parses a real station with dated price history, picks the LATEST price per product by PriceDate (not array order)", () => {
    const json = {
      CustomerResponse: {
        FuelStation: {
          FindFuelStation: {
            ResponseFlag: "S",
            ResponseMsg: "Successful",
            TokenNumber: "94eb6e66-83e4-cd81-4c62-0a7e1b104b03",
            FuelStations: [
              {
                FuelStationCode: "MHC117",
                FuelStationName: "PALM BEACH",
                FavouriteFlag: "N",
                ContactNumber: "9930505541",
                Address: "PLOT NO 7, SECTOR 18, OFF PALM BEACH MARG, BESIDES FULL STOP MALL, Sanpada, Navi Mumbai, Maharashtra 400706",
                Lattitude: "19.05508168",
                Longitude: "73.00673056",
                GetROAmenities: [
                  { FacilityCode: "2", FacilityName: "Petrol" },
                  { FacilityCode: "3", FacilityName: "Diesel" },
                ],
                HistoryFuelProducts: [
                  {
                    ProductName: "Petrol",
                    PriceDetails: [
                      // deliberately OLDER entry listed FIRST, to prove the parser sorts by date, not array order
                      { ProductPrice: "     108.00", PriceDate: "01-01-2026 06:00:00", LatestDate: "06:00 Thu,1st Jan 26", ProductUnit: "Rs/liter" },
                      { ProductPrice: "     111.28", PriceDate: "05-07-2026 06:00:00", LatestDate: "06:00 Sun,5th Jul 26", ProductUnit: "Rs/liter" },
                    ],
                  },
                  {
                    ProductName: "Diesel",
                    PriceDetails: [
                      { ProductPrice: "      97.90", PriceDate: "25-05-2026 07:44:00", ProductUnit: "Rs/liter" },
                    ],
                  },
                  {
                    ProductName: "CNG",
                    PriceDetails: [
                      { ProductPrice: "      86.00", PriceDate: "30-05-2026 00:00:00", ProductUnit: "Rs/kg" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const result = parseFindFuelStationResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      fuelStationCode: "MHC117",
      name: "PALM BEACH",
      address: "PLOT NO 7, SECTOR 18, OFF PALM BEACH MARG, BESIDES FULL STOP MALL, Sanpada, Navi Mumbai, Maharashtra 400706",
      contact: "9930505541",
      lat: 19.05508168,
      lng: 73.00673056,
      products: [
        { name: "Petrol", priceInr: 111.28 },
        { name: "Diesel", priceInr: 97.9 },
        { name: "CNG", priceInr: 86 },
      ],
    });
  });

  it("priceInr is null when ProductPrice is missing/unparseable/non-positive, but the product name is still kept", () => {
    const json = {
      CustomerResponse: {
        FuelStation: {
          FindFuelStation: {
            FuelStations: [
              {
                FuelStationCode: "TEST001",
                Lattitude: "10.0",
                Longitude: "20.0",
                HistoryFuelProducts: [
                  {
                    ProductName: "Auto LPG",
                    PriceDetails: [{ ProductPrice: "N/A", PriceDate: "01-01-2026 06:00:00" }],
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const result = parseFindFuelStationResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]!.products).toEqual([{ name: "Auto LPG", priceInr: null }]);
  });

  it("a product with an empty PriceDetails array gets priceInr: null", () => {
    const json = {
      CustomerResponse: {
        FuelStation: {
          FindFuelStation: {
            FuelStations: [
              {
                FuelStationCode: "TEST002",
                Lattitude: "10.0",
                Longitude: "20.0",
                HistoryFuelProducts: [{ ProductName: "EV", PriceDetails: [] }],
              },
            ],
          },
        },
      },
    };

    const result = parseFindFuelStationResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]!.products).toEqual([{ name: "EV", priceInr: null }]);
  });

  it("skips stations with missing FuelStationCode or non-finite coordinates", () => {
    const json = {
      CustomerResponse: {
        FuelStation: {
          FindFuelStation: {
            FuelStations: [
              { Lattitude: "10.0", Longitude: "20.0" }, // missing FuelStationCode
              { FuelStationCode: "TEST003", Lattitude: "bad", Longitude: "20.0" }, // bad lat
              { FuelStationCode: "TEST004", Lattitude: "10.0", Longitude: "20.0" }, // valid
            ],
          },
        },
      },
    };

    const result = parseFindFuelStationResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]!.fuelStationCode).toBe("TEST004");
  });

  it("falls back to fuelStationCode as name when FuelStationName is missing", () => {
    const json = {
      CustomerResponse: {
        FuelStation: {
          FindFuelStation: {
            FuelStations: [
              {
                FuelStationCode: "TEST005",
                Lattitude: "10.0",
                Longitude: "20.0",
                HistoryFuelProducts: [],
              },
            ],
          },
        },
      },
    };

    const result = parseFindFuelStationResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("TEST005");
  });

  it("returns [] for malformed/empty input", () => {
    expect(parseFindFuelStationResponse(null)).toEqual([]);
    expect(parseFindFuelStationResponse(undefined)).toEqual([]);
    expect(parseFindFuelStationResponse({})).toEqual([]);
    expect(parseFindFuelStationResponse({ CustomerResponse: {} })).toEqual([]);
    expect(parseFindFuelStationResponse("not an object")).toEqual([]);
    expect(
      parseFindFuelStationResponse({
        CustomerResponse: { FuelStation: { FindFuelStation: { FuelStations: "not-an-array" } } },
      })
    ).toEqual([]);
  });
});
