// Tweaked Tremor Drawer [v0.0.2]

import * as React from "react";
import * as DrawerPrimitives from "@radix-ui/react-dialog";

import { cx, focusRing } from "@/shared/lib/tremor-utils";

import { Button } from "@tremor/react";
import { XMarkIcon } from "@heroicons/react/24/outline";

const Drawer = (
  props: React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Root>
) => {
  return <DrawerPrimitives.Root tremor-id="tremor-raw" {...props} />;
};
Drawer.displayName = "Drawer";

const DrawerTrigger = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitives.Trigger>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Trigger>
>(({ className, ...props }, ref) => {
  return (
    <DrawerPrimitives.Trigger ref={ref} className={cx(className)} {...props} />
  );
});
DrawerTrigger.displayName = "Drawer.Trigger";

const DrawerClose = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Close>
>(({ className, ...props }, ref) => {
  return (
    <DrawerPrimitives.Close ref={ref} className={cx(className)} {...props} />
  );
});
DrawerClose.displayName = "Drawer.Close";

const DrawerPortal = DrawerPrimitives.Portal;

DrawerPortal.displayName = "DrawerPortal";

const DrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitives.Overlay>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Overlay>
>(({ className, ...props }, forwardedRef) => {
  return (
    <DrawerPrimitives.Overlay
      ref={forwardedRef}
      className={cx(
        // base
        "fixed inset-0 z-50",
        // background color
        "bg-black/30",
        // transition
        "data-[state=closed]:animate-hide data-[state=open]:animate-dialogOverlayShow",
        className
      )}
      {...props}
      style={{
        animationDuration: "400ms",
        animationFillMode: "forwards",
      }}
    />
  );
});

DrawerOverlay.displayName = "DrawerOverlay";

const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitives.Content>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Content>
>(({ className, ...props }, forwardedRef) => {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitives.Content
        ref={forwardedRef}
        className={cx(
          // base - sized to content (max-h + overflow-y-auto), not forced to
          // span the full viewport height. inset-y-0 made this a fixed
          // 100vh panel regardless of how little content it held, so any
          // alert with a short detail view (no incident, no history) left a
          // large blank area below the buttons that read as broken rather
          // than a real, deliberate panel size.
          "fixed z-50 right-0 top-1/2 -translate-y-1/2 flex w-[95vw] max-h-[90vh] flex-col overflow-y-auto rounded-lg border shadow-lg focus:outline-none sm:max-w-lg sm:mr-4",
          // border color
          "border-gray-200 dark:border-gray-900",
          // background color
          "bg-white dark:bg-[#090E1A]",
          // transition
          "data-[state=closed]:animate-drawerSlideRightAndFade data-[state=open]:animate-drawerSlideLeftAndFade",
          focusRing,
          className
        )}
        {...props}
      />
    </DrawerPortal>
  );
});

DrawerContent.displayName = "DrawerContent";

const DrawerHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ children, className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className="flex items-start justify-between gap-x-4 border-b border-gray-200 pb-4 dark:border-gray-900"
      {...props}
    >
      <div className={cx("mt-1 flex flex-col gap-y-1", className)}>
        {children}
      </div>
      <DrawerPrimitives.Close asChild>
        <Button
          variant="light"
          className="aspect-square p-1 hover:bg-gray-100 hover:dark:bg-gray-400/10"
        >
          <XMarkIcon className="size-6" aria-hidden="true" />
        </Button>
      </DrawerPrimitives.Close>
    </div>
  );
});

DrawerHeader.displayName = "Drawer.Header";

const DrawerTitle = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Title>
>(({ className, ...props }, forwardedRef) => (
  <DrawerPrimitives.Title
    ref={forwardedRef}
    className={cx(
      // base
      "text-base font-semibold",
      // text color
      "text-gray-900 dark:text-gray-50",
      className
    )}
    {...props}
  />
));

DrawerTitle.displayName = "DrawerTitle";

const DrawerBody = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => {
  return (
    <div ref={ref} className={cx("flex-1 min-h-0 p-4", className)} {...props} />
  );
});
DrawerBody.displayName = "Drawer.Body";

const DrawerDescription = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitives.Description>
>(({ className, ...props }, forwardedRef) => {
  return (
    <DrawerPrimitives.Description
      ref={forwardedRef}
      className={cx("text-gray-500 dark:text-gray-500", className)}
      {...props}
    />
  );
});

DrawerDescription.displayName = "DrawerDescription";

const DrawerFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => {
  return (
    <div
      className={cx(
        "flex flex-col-reverse border-t border-gray-200 pt-4 sm:flex-row sm:justify-end sm:space-x-2 dark:border-gray-900",
        className
      )}
      {...props}
    />
  );
};

DrawerFooter.displayName = "DrawerFooter";

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
};
