import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { buttonVariants, type Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row items-center gap-1", className)}
      {...props}
    />
  );
}

function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

type PaginationLinkProps = {
  isActive?: boolean;
  disabled?: boolean;
} & Pick<React.ComponentProps<typeof Button>, "size"> &
  React.ComponentProps<"a">;

function PaginationLink({
  className,
  isActive,
  size = "icon",
  ...props
}: PaginationLinkProps) {
  return (
    <a
      aria-current={isActive ? "page" : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        buttonVariants({
          variant: isActive ? "outline" : "ghost",
          size,
        }),
        className,
      )}
      {...props}
    />
  );
}

function PaginationPrevious({
  className,
  ...props
}: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink
      aria-label="Go to previous page"
      size="default"
      className={cn("gap-1 px-2.5 sm:pl-2.5", className)}
      {...props}
    >
      <ChevronLeftIcon />
      <span className="hidden sm:block">Previous</span>
    </PaginationLink>
  );
}

function PaginationNext({
  className,
  ...props
}: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink
      aria-label="Go to next page"
      size="default"
      className={cn("gap-1 px-2.5 sm:pr-2.5", className)}
      {...props}
    >
      <span className="hidden sm:block">Next</span>
      <ChevronRightIcon />
    </PaginationLink>
  );
}

function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" />
      <span className="sr-only">More pages</span>
    </span>
  );
}

// Properties Definition
const paginationLinkPropertiesDefinition: PropertiesPanelDefinition<PaginationLinkProps> =
  {
    general: Section.category(PropsCategory.Content).children({
      isActive: Prop.boolean().propertiesPanel({
        label: "Is active",
        description: "Whether the link is active",
        controlType: "SWITCH",
      }),
    }),
    appearance: Section.category(PropsCategory.Appearance).children({
      size: Prop.string<"sm" | "default" | "lg">().propertiesPanel({
        label: "Size",
        controlType: "DROP_DOWN",
        options: [
          { label: "Small", value: "sm" },
          { label: "Default", value: "default" },
          { label: "Large", value: "lg" },
        ],
        description: "Size variant of the pagination link",
      }),
    }),
    interaction: Section.category(PropsCategory.Interaction).children({
      disabled: Prop.boolean().propertiesPanel({
        label: "Disabled",
        description: "Whether the link is disabled",
        controlType: "SWITCH",
      }),
    }),
    events: Section.category(PropsCategory.EventHandlers).children({
      onClick: Prop.eventHandler().propertiesPanel({
        label: "onClick",
        description: "Triggered when the link is clicked",
      }),
    }),
  };

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "custom",
  isDraggable: true,
  description:
    "Pagination component with page navigation, next and previous links for navigating through large datasets.",
};

// Registration
registerComponent(Pagination).editorConfig(editorConfig);

registerComponent(PaginationLink, paginationLinkPropertiesDefinition);
registerComponent(PaginationNext, paginationLinkPropertiesDefinition);
registerComponent(PaginationPrevious, paginationLinkPropertiesDefinition);
registerComponent(PaginationEllipsis);
registerComponent(PaginationItem);
registerComponent(PaginationContent);

export {
  Pagination,
  PaginationContent,
  PaginationLink,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
};
