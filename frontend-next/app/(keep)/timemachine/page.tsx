import { Suspense } from "react";
import { TimeMachineClient } from "./TimeMachineClient";

export const metadata = {
  title: "Time Machine | Nexus AIOps",
  description: "Replay how an incident formed, signal by signal",
};

export default function Page() {
  // useSearchParams (?id=) needs a Suspense boundary in the app router
  return (
    <Suspense>
      <TimeMachineClient />
    </Suspense>
  );
}
