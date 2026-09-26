import { applyFacets, emptySelections, FACET_FIELDS } from "../AlertFacets";
import { alert } from "../../lib/__fixtures__/alertlens";

const alerts = [
  alert({ id: "1", severity: "critical", status: "firing", service: "api-gateway", source: "datadog" }),
  alert({ id: "2", severity: "critical", status: "resolved", service: "order-api", source: "grafana" }),
  alert({ id: "3", severity: "info", status: "firing", service: "order-api", source: "datadog" }),
  alert({ id: "4", severity: "high", status: "suppressed", service: "auth-service", source: "prometheus" }),
];

const withFacet = (key: keyof ReturnType<typeof emptySelections>, values: string[]) => {
  const sel = emptySelections();
  sel[key] = new Set(values);
  return sel;
};

describe("applyFacets", () => {
  it("returns everything when nothing is selected", () => {
    expect(applyFacets(alerts, emptySelections())).toHaveLength(4);
  });

  it("filters by a single value", () => {
    const out = applyFacets(alerts, withFacet("severity", ["critical"]));
    expect(out.map((a) => a.id)).toEqual(["1", "2"]);
  });

  it("ORs values inside one facet", () => {
    const out = applyFacets(alerts, withFacet("severity", ["critical", "info"]));
    expect(out.map((a) => a.id)).toEqual(["1", "2", "3"]);
  });

  it("ANDs across facets", () => {
    const sel = emptySelections();
    sel.severity = new Set(["critical"]);
    sel.status = new Set(["firing"]);
    // critical AND firing -> only alert 1
    expect(applyFacets(alerts, sel).map((a) => a.id)).toEqual(["1"]);
  });

  it("returns nothing when facets cannot be satisfied together", () => {
    const sel = emptySelections();
    sel.severity = new Set(["info"]);
    sel.status = new Set(["suppressed"]);
    expect(applyFacets(alerts, sel)).toHaveLength(0);
  });

  it("filters by service and source", () => {
    expect(
      applyFacets(alerts, withFacet("service", ["order-api"])).map((a) => a.id)
    ).toEqual(["2", "3"]);
    expect(
      applyFacets(alerts, withFacet("source", ["datadog"])).map((a) => a.id)
    ).toEqual(["1", "3"]);
  });

  it("covers every declared facet field", () => {
    for (const { key } of FACET_FIELDS) {
      // Selecting a value that no alert has must exclude everything, which
      // proves the field is actually consulted.
      expect(applyFacets(alerts, withFacet(key, ["__none__"]))).toHaveLength(0);
    }
  });

  it("does not mutate the input", () => {
    const before = alerts.map((a) => a.id).join(",");
    applyFacets(alerts, withFacet("severity", ["critical"]));
    expect(alerts.map((a) => a.id).join(",")).toBe(before);
  });
});
