import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

import { Link, type LinkProps } from "./link";

// Base Breadcrumb Primitives
function BreadcrumbPrimitive({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

function BreadcrumbListPrimitive({
  className,
  ...props
}: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm break-words sm:gap-2.5",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItemComponent({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

function BreadcrumbLinkPrimitive({
  asChild,
  className,
  ...props
}: React.ComponentPropsWithRef<"a"> & {
  asChild?: boolean;
}) {
  const Comp: any = asChild ? Slot : "a";

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn("hover:text-foreground transition-colors", className)}
      {...props}
    />
  );
}

function BreadcrumbPageComponent({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("text-foreground font-normal", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparatorComponent({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {React.isValidElement(children) ? children : <ChevronRight />}
    </li>
  );
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  );
}

// Main Breadcrumb Component
type BreadcrumbProps = React.ComponentPropsWithoutRef<
  typeof BreadcrumbPrimitive
>;

const Breadcrumb = ({
  children,
  style,
  className,
  ...props
}: BreadcrumbProps) => {
  return (
    <BreadcrumbPrimitive {...props} style={style} className={className}>
      <BreadcrumbListPrimitive>{children}</BreadcrumbListPrimitive>
    </BreadcrumbPrimitive>
  );
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<BreadcrumbProps> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx().propertiesPanel({
      label: "Items",
      description: "The items to display",
    }),
  }),
};

// Editor Config
const editorConfig: EditorConfig = {
  icon: "link",
  description:
    "Displays the path to the current resource using a hierarchy of links",
  isDroppable: false,
};

// Register Main Component
registerComponent(Breadcrumb, propertiesDefinition).editorConfig(editorConfig);

// Register Child Components

// BreadcrumbItem Component
const propertiesDefinitionItem = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

type BreadcrumbItemProps = React.ComponentPropsWithoutRef<
  typeof BreadcrumbItemComponent
>;

const BreadcrumbItem = ({ children, ...props }: BreadcrumbItemProps) => {
  return (
    <BreadcrumbItemComponent {...props}>{children}</BreadcrumbItemComponent>
  );
};

registerComponent(BreadcrumbItem, propertiesDefinitionItem).editorConfig({
  isDroppable: false,
  isDraggable: false,
});

// BreadcrumbLink Component
const propertiesDefinitionLink = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

const BreadcrumbLink = ({ children, className, ...props }: LinkProps) => {
  return (
    <BreadcrumbLinkPrimitive asChild className={className}>
      <Link {...props} applyLinkStyles={false}>
        {children}
      </Link>
    </BreadcrumbLinkPrimitive>
  );
};

registerComponent(BreadcrumbLink, propertiesDefinitionLink).editorConfig({
  isDroppable: false,
  isDraggable: false,
});

// BreadcrumbPage Component
const propertiesDefinitionPage = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

type BreadcrumbPageProps = React.ComponentPropsWithoutRef<
  typeof BreadcrumbPageComponent
>;

const BreadcrumbPage = ({ children, ...props }: BreadcrumbPageProps) => {
  return (
    <BreadcrumbPageComponent {...props}>{children}</BreadcrumbPageComponent>
  );
};

registerComponent(BreadcrumbPage, propertiesDefinitionPage).editorConfig({
  isDroppable: false,
  isDraggable: false,
});

// BreadcrumbSeparator Component
const propertiesDefinitionSeparator = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

type BreadcrumbSeparatorProps = React.ComponentPropsWithoutRef<
  typeof BreadcrumbSeparatorComponent
>;

const BreadcrumbSeparator = ({ ...props }: BreadcrumbSeparatorProps) => {
  return <BreadcrumbSeparatorComponent {...props} />;
};

registerComponent(
  BreadcrumbSeparator,
  propertiesDefinitionSeparator,
).editorConfig({
  isDroppable: false,
  isDraggable: false,
});

export {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
