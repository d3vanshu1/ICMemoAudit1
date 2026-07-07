import * as AvatarPrimitive from "@radix-ui/react-avatar";
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

function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden rounded-full",
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted flex size-full items-center justify-center rounded-full",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };

// Properties Definition for Avatar (root)
const avatarPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof Avatar>
> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

const avatarEditorConfig: EditorConfig = {
  icon: "image",
  description: "An image element with a fallback for representing the user",
};

// Properties Definition for AvatarImage
const avatarImagePropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof AvatarImage>
> = {
  general: Section.category(PropsCategory.Content).children({
    src: Prop.string().propertiesPanel({
      label: "Image source",
      description: "URL of the avatar image",
    }),
    alt: Prop.string().propertiesPanel({
      label: "Alt text",
      description: "Alternative text for the avatar image",
    }),
  }),
};

// Properties Definition for AvatarFallback
const avatarFallbackPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof AvatarFallback>
> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx().propertiesPanel({
      label: "Fallback content",
      description:
        "Content to display when image fails to load (typically initials)",
    }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    delayMs: Prop.number().propertiesPanel({
      label: "Delay (ms)",
      description:
        "How long to wait before showing the fallback. This is useful to only show the fallback for those with slower connections.",
    }),
  }),
};

// Register Components
registerComponent(Avatar, avatarPropertiesDefinition).editorConfig(
  avatarEditorConfig,
);
registerComponent(AvatarImage, avatarImagePropertiesDefinition);
registerComponent(AvatarFallback, avatarFallbackPropertiesDefinition);
