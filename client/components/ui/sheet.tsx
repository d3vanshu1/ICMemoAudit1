import * as SheetPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import {
  Prop,
  PropsCategory,
  registerComponent,
  Section,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "p-4 bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
          side === "right" &&
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b",
          side === "bottom" &&
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof Sheet>
> = {
  general: Section.category(PropsCategory.Content).children({
    open: Prop.boolean().propertiesPanel({
      label: "Open",
      controlType: "SWITCH",
      description: "Whether the component is currently open and visible",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    children: Prop.jsx(),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    defaultOpen: Prop.boolean().propertiesPanel({
      label: "Default is open",
      description: "Whether the component is open by default",
    }),
    modal: Prop.boolean()
      .propertiesPanel({
        label: "Modal",
        description: "Prevent clicking outside from closing the dialog",
      })
      .docs({
        description:
          "When true, interaction with outside elements will be disabled",
      }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onOpenChange: Prop.eventHandler().propertiesPanel({
      label: "onOpenChange",
      computedArgs: [
        {
          name: "open",
          type: "boolean",
          description: "Whether the sheet is open",
        },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "slideout",
  isDetached: true,
  isDraggable: false,
  description:
    "A sheet component that complements the main content of the screen",
};

const childrenPropertiesDefinition = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

const sheetContentPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof SheetContent>
> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    side: Prop.string<"top" | "right" | "bottom" | "left">().propertiesPanel({
      label: "Side",
      controlType: "DROP_DOWN",
      description: "Which side of the screen the sheet appears from",
      options: [
        { label: "Right", value: "right" },
        { label: "Left", value: "left" },
        { label: "Top", value: "top" },
        { label: "Bottom", value: "bottom" },
      ],
    }),
  }),
};

// Registration
registerComponent(Sheet, propertiesDefinition).editorConfig(editorConfig);
registerComponent(SheetContent, sheetContentPropertiesDefinition);
registerComponent(SheetHeader, childrenPropertiesDefinition);
registerComponent(SheetFooter, childrenPropertiesDefinition);
registerComponent(SheetTitle, childrenPropertiesDefinition);
registerComponent(SheetDescription, childrenPropertiesDefinition);
