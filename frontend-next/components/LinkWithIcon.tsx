import React, { AnchorHTMLAttributes, ReactNode, useState } from "react";
import Link, { LinkProps } from "next/link";
import { IconType } from "react-icons/lib";
import { Badge, Icon } from "@tremor/react";
import { usePathname } from "next/navigation";
import { Trashcan } from "@/components/icons";
import clsx from "clsx";
import { ShortNumber } from "./ui";

type LinkWithIconProps = {
  children: ReactNode;
  icon: IconType;
  count?: number;
  isBeta?: boolean;
  isDeletable?: boolean;
  onDelete?: () => void;
  className?: string;
  testId?: string;
  isExact?: boolean;
  iconClassName?: string;
  renderBeforeCount?: () => React.JSX.Element | undefined;
  onIconClick?: (e: React.MouseEvent) => void;
} & LinkProps &
  AnchorHTMLAttributes<HTMLAnchorElement>;

export const LinkWithIcon = ({
  icon,
  children,
  tabIndex = 0,
  count,
  isBeta = false,
  isDeletable = false,
  onDelete,
  className,
  testId,
  isExact = false,
  iconClassName,
  renderBeforeCount,
  onIconClick,
  ...restOfLinkProps
}: LinkWithIconProps) => {
  const pathname = usePathname();
  const [isHovered, setIsHovered] = useState(false);
  const isActive = isExact
    ? decodeURIComponent(pathname || "") === restOfLinkProps.href?.toString()
    : decodeURIComponent(pathname || "").startsWith(
        restOfLinkProps.href?.toString() || ""
      );

  // Active state needs to actually read as "selected" at a glance: a green
  // gradient row with a left accent bar, and the icon in a solid green tile.
  // Inactive icons sit in a soft grey tile that tints green on hover.
  const iconClasses = clsx(
    "!p-1 rounded-lg transition-colors duration-150",
    {
      "bg-green-600 !text-white": isActive,
      "bg-gray-100 text-gray-500 group-hover:bg-green-100 group-hover:text-green-700":
        !isActive,
    },
    iconClassName
  );

  const textClasses = clsx("truncate", {
    "text-green-700 font-semibold": isActive,
    "text-gray-700 group-hover:text-green-600": !isActive,
  });

  const handleMouseEnter = () => setIsHovered(true);
  const handleMouseLeave = () => setIsHovered(false);

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (restOfLinkProps.onClick) {
      restOfLinkProps.onClick(e);
    }
  };

  const handleIconClick = (e: React.MouseEvent) => {
    if (onIconClick) {
      e.preventDefault();
      e.stopPropagation();
      onIconClick(e);
    }
  };

  return (
    <div
      className={clsx(
        "relative flex items-center justify-between py-1 px-2 font-medium rounded-xl focus:ring focus:ring-green-300 group w-full min-w-0 transition-colors duration-150",
        {
          "bg-gradient-to-r from-green-100/80 to-green-50/30 shadow-[inset_0_0_0_1px_rgba(22,163,74,0.12)]":
            isActive,
          "hover:bg-gray-100/80": !isActive,
        },
        className
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-testid={`${testId}-link-container`}
    >
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-green-600"
        />
      )}
      <Link
        tabIndex={tabIndex}
        {...restOfLinkProps}
        className="flex items-center space-x-2 flex-1 min-w-0"
        onClick={onClick}
        data-testid={`${testId}-link`}
      >
        {onIconClick ? (
          <button
            onClick={handleIconClick}
            className="flex items-center p-0 bg-transparent border-none cursor-pointer"
            type="button"
          >
            <Icon className={iconClasses} icon={icon} />
          </button>
        ) : (
          <Icon className={iconClasses} icon={icon} />
        )}
        <span className={textClasses}>{children}</span>
      </Link>
      <div className="flex items-center">
        {count !== undefined && count !== null && (
          <Badge
            size="xs"
            color="emerald"
            data-testid={`${testId}-badge`}
            className="px-1 mr-0.5 min-w-5"
          >
            <div className="flex gap-1 items-center">
              {renderBeforeCount && renderBeforeCount() && (
                <span>{renderBeforeCount()}</span>
              )}
              <ShortNumber value={count}></ShortNumber>
            </div>
          </Badge>
        )}
        {isBeta && (
          <Badge color="emerald" size="xs" className="ml-1">
            Beta
          </Badge>
        )}
        {isDeletable && onDelete && (
          <button
            onClick={onDelete}
            className={`flex items-center text-slate-400 hover:text-red-500 p-0`}
          >
            <Trashcan className="text-slate-400 hover:text-red-500 group-hover:block hidden h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
};
