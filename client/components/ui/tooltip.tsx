import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import {
  registerComponent,
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

// Properties Definition for Tooltip (root)
const tooltipPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof Tooltip>
> = {
  general: Section.category(PropsCategory.Content).children({
    open: Prop.boolean().propertiesPanel({
      label: "Open",
      controlType: "SWITCH",
      description:
        "The controlled open state of the tooltip. Must be used in conjunction with `onOpenChange`.",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    children: Prop.jsx(),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    defaultOpen: Prop.boolean().propertiesPanel({
      label: "Default open",
      description: "Whether the tooltip is open by default",
    }),
    delayDuration: Prop.number().propertiesPanel({
      label: "Delay duration",
      description:
        "The duration from when the mouse enters a tooltip trigger until the tooltip opens (in milliseconds)",
    }),
    disableHoverableContent: Prop.boolean().propertiesPanel({
      label: "Disable hoverable content",
      description:
        "When true, trying to hover the content will result in the tooltip closing",
    }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onOpenChange: Prop.eventHandler().propertiesPanel({
      label: "onOpenChange",
      computedArgs: [
        {
          name: "open",
          type: "boolean",
          description: "Whether the tooltip is open",
        },
      ],
    }),
  }),
};

const tooltipEditorConfig: EditorConfig = {
  icon: "modal",
  isDetached: true,
  isDraggable: false,
  description:
    "A popup that displays information related to an element when the element receives keyboard focus or the mouse hovers over it.",
};

// Properties Definition for TooltipContent
const tooltipContentPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof TooltipContent>
> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    side: Prop.string<"top" | "right" | "bottom" | "left">().propertiesPanel({
      label: "Side",
      controlType: "DROP_DOWN",
      description: "The preferred side of the trigger to render against",
      options: [
        { label: "Top", value: "top" },
        { label: "Right", value: "right" },
        { label: "Bottom", value: "bottom" },
        { label: "Left", value: "left" },
      ],
    }),
    align: Prop.string<"start" | "center" | "end">().propertiesPanel({
      label: "Align",
      controlType: "DROP_DOWN",
      description: "The preferred alignment against the trigger",
      options: [
        { label: "Start", value: "start" },
        { label: "Center", value: "center" },
        { label: "End", value: "end" },
      ],
    }),
    sideOffset: Prop.number().propertiesPanel({
      label: "Side offset",
      description: "The distance in pixels from the trigger",
    }),
    avoidCollisions: Prop.boolean().propertiesPanel({
      label: "Avoid collisions",
      description:
        "Whether the tooltip should avoid collisions with other elements",
    }),
  }),
};

const childrenPropertiesDefinition = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

// Register Components
registerComponent(Tooltip, tooltipPropertiesDefinition).editorConfig(
  tooltipEditorConfig,
);
registerComponent(TooltipTrigger, childrenPropertiesDefinition);
registerComponent(TooltipContent, tooltipContentPropertiesDefinition);
