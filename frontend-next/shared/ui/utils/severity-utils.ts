// severity is used for alerts and incidents
export enum UISeverity {
  Critical = "critical",
  High = "high",
  Warning = "warning",
  Medium = "medium",
  Low = "low",
  Info = "info",
  Error = "error",
}

export const getSeverityBgClassName = (severity?: UISeverity) => {
  switch (severity) {
    case "critical":
      return "bg-red-500";
    case "high":
    case "error":
      return "bg-orange-500";
    case "medium":
    case "warning":
      return "bg-yellow-500";
    case "info":
      return "bg-blue-500";
    default:
      return "bg-emerald-500";
  }
};

export const getSeverityLabelClassName = (severity?: UISeverity) => {
  switch (severity) {
    case "critical":
      return "bg-red-100";
    case "high":
    case "error":
      return "bg-orange-100";
    case "medium":
    case "warning":
      return "bg-yellow-100";
    case "info":
      return "bg-blue-100";
    default:
      return "bg-emerald-100";
  }
};

// -700 on the -100 label tint: the -500 shades measured 2.2-3.1:1, under AA.
export const getSeverityTextClassName = (severity?: UISeverity) => {
  switch (severity) {
    case "critical":
      return "text-red-700";
    case "high":
    case "error":
      return "text-orange-700";
    case "medium":
    case "warning":
      return "text-amber-900";
    case "info":
      return "text-blue-700";
    default:
      return "text-emerald-700";
  }
};
