import type { IconName } from "lucide-react/dynamic";
import * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Types
type FileInputProps = React.ComponentPropsWithoutRef<typeof Input> & {
  acceptedFileTypes?: string[];
  icon?: string;
  iconPosition?: "left" | "right";
};

// Main Component
const FileInput = ({
  acceptedFileTypes,
  style,
  multiple,
  icon,
  iconPosition,
  children: _children,
  ...props
}: FileInputProps) => {
  const accept = React.useMemo(
    () => (acceptedFileTypes ? acceptedFileTypes.join(",") : undefined),
    [acceptedFileTypes],
  );

  if (icon) {
    const isLeft = iconPosition === "left";
    return (
      <div className={cn("relative", props.className)} style={style}>
        <Input
          className={cn(isLeft ? "pl-10" : "pr-10")}
          type="file"
          accept={accept}
          {...props}
        />
        <div
          className={cn(
            "absolute inset-y-0 flex items-center pointer-events-none",
            isLeft ? "left-0 pl-3" : "right-0 pr-3",
          )}
        >
          <Icon
            icon={icon as IconName}
            style={{
              width: 16,
              height: 16,
            }}
          />
        </div>
      </div>
    );
  }

  return <Input style={style} type="file" accept={accept} {...props} />;
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<FileInputProps> = {
  general: Section.category(PropsCategory.Content).children({
    multiple: Prop.boolean().propertiesPanel({
      label: "Multiple files",
      controlType: "SWITCH",
      description: "Allow multiple file selection",
    }),
    acceptedFileTypes: Prop.array<string>().propertiesPanel({
      label: "Accepted file types",
      controlType: "FUNCTION_CODE_EDITOR",
      description:
        "Array of MIME types or file extensions (e.g. image/*, .pdf, .doc)",
    }),
    icon: Prop.string<string>()
      .propertiesPanel({
        label: "Icon",
        description: "Icon to display in the input (e.g., 'search', 'lock')",
        defaultOnAdd: "search",
        isRemovable: true,
        visibility: "SHOW_NAME",
        controlType: "ICON_SELECTOR",
      })
      .docs({
        description:
          "The icon to display in the component. You can use the Lucide icon library to find the icon you want.",
      }),
    iconPosition: Prop.string<"left" | "right">().propertiesPanel({
      label: "Icon position",
      controlType: "RADIO_BUTTON_GROUP",
      description: "Position of the icon within the input",
      options: [
        { label: "Left", value: "left" },
        { label: "Right", value: "right" },
      ],
      isVisible: function (this: any) {
        return Boolean(this.icon);
      },
    }),
  }),

  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the input is disabled",
    }),
    required: Prop.boolean().propertiesPanel({
      label: "Required",
      controlType: "SWITCH",
      description: "Whether the input is required",
    }),
    readOnly: Prop.boolean().propertiesPanel({
      label: "Read only",
      controlType: "SWITCH",
      description: "Whether the input is read only",
    }),
    autoFocus: Prop.boolean().propertiesPanel({
      label: "Auto focus",
      controlType: "SWITCH",
      description: "Whether the input should auto focus on page load",
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onChange: Prop.eventHandler().propertiesPanel({
      label: "On change",
      description: "Triggered when the file input changes",
      computedArgs: [
        {
          name: "event",
          type: "object",
          description: "The event object",
        },
      ],
    }),
    onFocus: Prop.eventHandler().propertiesPanel({
      label: "On focus",
      description: "Triggered when the input receives focus",
    }),
    onBlur: Prop.eventHandler().propertiesPanel({
      label: "On blur",
      description: "Triggered when the input loses focus",
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "file-picker",
  description: "A file input component",
};

// Registration
registerComponent(FileInput, propertiesDefinition).editorConfig(editorConfig);

export { FileInput };
