import { Button } from "@tremor/react";

import {
  Drawer as TremorDrawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DrawerDescription,
} from "./TremorDrawer";

export function Drawer({
  children,
  isOpen,
  onClose,
  title,
  description,
  className,
}: {
  children: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <TremorDrawer
      open={isOpen}
      onOpenChange={(modalOpen) => {
        if (!modalOpen) {
          onClose();
        }
      }}
    >
      {/* <DrawerTrigger asChild>
        <Button variant="secondary">Open Drawer</Button>
      </DrawerTrigger> */}
      {/* Fixed width, not a viewport percentage - on a large monitor
          lg:max-w-[50%] meant ~960px, genuinely covering roughly half the
          screen and everything behind it, which read as content being cut
          off rather than an intentional panel width. */}
      <DrawerContent className="max-w-full sm:max-w-xl">
        {/* Radix requires a DialogTitle for screen readers even when the
            visible content (e.g. AlertDetailDrawer's own header) already
            names what this is - sr-only keeps it out of the visual layout
            while satisfying that requirement. */}
        <DrawerTitle className="sr-only">{title || "Details"}</DrawerTitle>
        <DrawerBody>{children}</DrawerBody>
        {/* <DrawerFooter className="mt-6">
          <DrawerClose asChild>
            <Button
              className="mt-2 w-full sm:mt-0 sm:w-fit"
              variant="secondary"
            >
              Go back
            </Button>
          </DrawerClose>
          <DrawerClose asChild>
            <Button className="w-full sm:w-fit">Ok, got it!</Button>
          </DrawerClose>
        </DrawerFooter> */}
      </DrawerContent>
    </TremorDrawer>
  );
}
