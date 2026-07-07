import { useMemo } from "react";
import { Link as BaseLink } from "react-router";
import type { LinkProps as RouterLinkProps } from "react-router";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

import { Button } from "./button";

// Base Link Component
type BaseLinkProps = RouterLinkProps &
  React.RefAttributes<HTMLAnchorElement> & {
    applyLinkStyles?: boolean;
  };

function BaseLinkComponent({
  children,
  className,
  applyLinkStyles = true,
  ...props
}: BaseLinkProps) {
  return (
    <BaseLink
      className={cn(
        "cursor-pointer",
        applyLinkStyles && "underline underline-offset-4",
        className,
      )}
      {...props}
    >
      {children}
    </BaseLink>
  );
}

// Link with Variant Support
export type LinkProps = BaseLinkProps & {
  openInNewTab?: boolean;
  variant?: "link" | "button-default" | "button-secondary";
} & Record<string, unknown>;

const Link = ({
  children,
  openInNewTab,
  variant,
  style,
  ...props
}: LinkProps) => {
  const linkProps = useMemo(
    () => ({
      ...props,
      ...(openInNewTab && {
        target: "_blank",
        rel: "noopener noreferrer",
      }),
    }),
    [props, openInNewTab],
  );

  const buttonVariant =
    variant === "button-default"
      ? "default"
      : variant === "button-secondary"
        ? "secondary"
        : undefined;

  if (buttonVariant) {
    return (
      <Button asChild variant={buttonVariant} style={style}>
        <BaseLinkComponent applyLinkStyles={false} {...linkProps}>
          {children}
        </BaseLinkComponent>
      </Button>
    );
  }

  return (
    <BaseLinkComponent style={style} {...linkProps}>
      {children}
    </BaseLinkComponent>
  );
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<LinkProps> = {
  general: Section.category(PropsCategory.Content).add({
    children: Prop.jsx().propertiesPanel({
      label: "Text",
    }),
    openInNewTab: Prop.boolean().propertiesPanel({
      label: "Open in new tab",
      controlType: "SWITCH",
      description: "Open the link in a new browser tab",
    }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    variant: Prop.string<"link" | "button-default" | "button-secondary">()

      .propertiesPanel({
        label: "Style",
        controlType: "DROP_DOWN",
        options: [
          { label: "Link", value: "link" },
          { label: "Default button", value: "button-default" },
          { label: "Secondary button", value: "button-secondary" },
        ],
        description: "Choose how the link should be styled",
      }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onClick: Prop.eventHandler().propertiesPanel({
      label: "onClick",
      description: "Triggered when the badge is clicked",
    }),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "link",
  description:
    "A link component used for navigating to other pages in the application.",
  hasExtendedClickArea: true,
  isDroppable: false,
};

// Register Component
registerComponent(Link, propertiesDefinition).editorConfig(editorConfig);

export { Link };
