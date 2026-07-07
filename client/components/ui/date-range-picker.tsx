import { format } from "date-fns";
import { ChevronDownIcon, CalendarIcon } from "lucide-react";
import { useMemo, useState, useEffect } from "react";
import type { ComponentPropsWithoutRef } from "react";
import type { DropdownProps, Matcher, DateRange } from "react-day-picker";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectTrigger,
  SelectContent,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Date Output Formats
const DATE_OUTPUT_FORMATS: {
  label: string;
  value: string | undefined;
}[] = [
  {
    label: "MM-dd-yyyy",
    value: "MM-dd-yyyy",
  },
  {
    label: "yyyy-MM-dd",
    value: "yyyy-MM-dd",
  },
  {
    label: "dd-MM-yyyy",
    value: "dd-MM-yyyy",
  },
  {
    label: "do MMM yyyy",
    value: "do MMM yyyy",
  },
  {
    label: "MM/dd/yyyy",
    value: "MM/dd/yyyy",
  },
  {
    label: "yyyy/MM/dd",
    value: "yyyy/MM/dd",
  },
  {
    label: "dd/MM/yyyy",
    value: "dd/MM/yyyy",
  },
];

// Component Props
type ComponentProps = ComponentPropsWithoutRef<typeof Popover> & {
  value?: { from?: string; to?: string };
  onValueChange?: (value: { from: string; to: string }) => void;
  minDate?: string;
  maxDate?: string;
  disabled?: boolean;
  displayFormat?: string;
  buttonVariant?:
    | "default"
    | "outline"
    | "secondary"
    | "ghost"
    | "link"
    | "destructive";
  captionLayout?: "label" | "dropdown" | "dropdown-months" | "dropdown-years";
  numberOfMonths?: number;
  placeholder?: string;
  className?: string;
};

const CustomCalendarDropdown = ({
  options,
  value,
  onChange,
}: DropdownProps) => {
  const handleValueChange = (newValue: string) => {
    if (onChange) {
      const syntheticEvent = {
        target: {
          value: newValue,
        },
      } as React.ChangeEvent<HTMLSelectElement>;
      onChange(syntheticEvent);
    }
  };
  return (
    <Select value={value?.toString()} onValueChange={handleValueChange}>
      <SelectTrigger className={"rdp-dropdown"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[200px]">
        {options?.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value.toString()}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const DateRangePicker = (props: ComponentProps) => {
  const {
    value,
    onValueChange,
    minDate,
    maxDate,
    disabled,
    displayFormat = "MM/dd/yyyy",
    buttonVariant,
    captionLayout,
    numberOfMonths,
    placeholder,
    className,
    ...rest
  } = props;
  const [open, setOpen] = useState(false);

  const dateRange = useMemo(() => {
    const range: {
      from?: Date;
      to?: Date;
    } = {};
    if (minDate) {
      range.from = new Date(minDate);
    }
    if (maxDate) {
      range.to = new Date(maxDate);
    }
    return Object.keys(range).length > 0 ? range : undefined;
  }, [minDate, maxDate]);

  const disabledMatcher = useMemo(() => {
    const matchers: any[] = [];
    if (dateRange?.from) {
      matchers.push({
        before: dateRange?.from,
      });
    }
    if (dateRange?.to) {
      matchers.push({
        after: dateRange?.to,
      });
    }
    return matchers.length > 0 ? matchers : undefined;
  }, [dateRange]);

  const selectedRange: DateRange | undefined = useMemo(() => {
    return {
      from: value?.from ? new Date(value.from) : undefined,
      to: value?.to ? new Date(value.to) : undefined,
    };
  }, [value]);

  const handleRangeSelect = (range: DateRange | undefined) => {
    const newFromValue = range?.from?.toISOString() || "";
    const newToValue = range?.to?.toISOString() || "";
    void onValueChange?.({
      from: newFromValue,
      to: newToValue,
    });
  };

  const getDisplayText = () => {
    if (!selectedRange?.from && !selectedRange?.to) {
      return placeholder;
    }
    if (selectedRange?.from && selectedRange?.to) {
      return `${format(selectedRange.from, displayFormat)} - ${format(selectedRange.to, displayFormat)}`;
    }
    if (selectedRange?.from) {
      return `${format(selectedRange.from, displayFormat)} - ...`;
    }
    return placeholder;
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  return (
    <div className={className} {...rest}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="w-full" asChild>
          <div>
            <Button
              variant="outline"
              disabled={disabled}
              className={cn(
                "w-full justify-between font-normal",
                !selectedRange?.from &&
                  !selectedRange?.to &&
                  "text-muted-foreground",
              )}
            >
              <div className="flex items-center gap-2">
                <CalendarIcon className="h-4 w-4" />
                {getDisplayText()}
              </div>
              <ChevronDownIcon className="h-4 w-4" />
            </Button>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            showOutsideDays={false}
            buttonVariant={buttonVariant}
            captionLayout={captionLayout}
            disabled={disabled ? true : (disabledMatcher as Matcher[])}
            mode="range"
            selected={selectedRange}
            onSelect={handleRangeSelect}
            numberOfMonths={numberOfMonths}
            components={{
              Dropdown: CustomCalendarDropdown,
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<ComponentProps> = {
  general: Section.category(PropsCategory.Content).children({
    value: Prop.any<{ from?: string; to?: string }>().propertiesPanel({
      label: "Value",
      controlType: "INPUT_TEXT",
      description: "The controlled value of the date range picker",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    defaultFromValue: Prop.string().propertiesPanel({
      controlType: "INPUT_TEXT",
      defaultOnAdd: function (this: { valueFormat: string }) {
        const today = new Date();
        return today.toISOString();
      },
      description:
        "Sets the default start date of the component. The date is updated if the default date changes",
      isRemovable: true,
      label: "Default from date",
      placeholder: "Enter default from date",
      visibility: "SHOW_NAME",
    }),
    defaultToValue: Prop.string().propertiesPanel({
      controlType: "INPUT_TEXT",
      defaultOnAdd: function (this: { valueFormat: string }) {
        const weekFromNow = new Date();
        weekFromNow.setDate(weekFromNow.getDate() + 7);
        return weekFromNow.toISOString();
      },
      description:
        "Sets the default end date of the component. The date is updated if the default date changes",
      isRemovable: true,
      label: "Default to date",
      placeholder: "Enter default to date",
      visibility: "SHOW_NAME",
    }),
    displayFormat: Prop.string().propertiesPanel({
      label: "Display format",
      description: "The format of the date to display",
      placeholder: "Enter display format",
      isRemovable: true,
      controlType: "DROP_DOWN",
      options: DATE_OUTPUT_FORMATS,
    }),
    minDate: Prop.string().propertiesPanel({
      label: "Min date",
      description: "The minimum date of the date range picker",
      placeholder: "Enter min date",
      defaultOnAdd: function (this: { valueFormat: string }) {
        return new Date().toISOString();
      },
      visibility: "SHOW_NAME",
      isRemovable: true,
    }),
    maxDate: Prop.string().propertiesPanel({
      label: "Max date",
      description: "The maximum date of the date range picker",
      placeholder: "Enter max date",
      defaultOnAdd: function (this: { valueFormat: string }) {
        const nextYear = new Date();
        nextYear.setFullYear(nextYear.getFullYear() + 1);
        return nextYear.toISOString();
      },
      visibility: "SHOW_NAME",
      isRemovable: true,
    }),
    placeholder: Prop.string().propertiesPanel({
      label: "Placeholder",
      description: "Placeholder text when no dates are selected",
      placeholder: "Enter placeholder text",
      isRemovable: true,
    }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    buttonVariant: Prop.string<
      "ghost" | "outline" | "default" | "secondary" | "destructive"
    >().propertiesPanel({
      label: "Button variant",
      description: "The variant of the button",
      controlType: "DROP_DOWN",
      options: [
        { label: "Ghost", value: "ghost" },
        { label: "Outline", value: "outline" },
        { label: "Default", value: "default" },
        { label: "Secondary", value: "secondary" },
        { label: "Destructive", value: "destructive" },
      ],
    }),
    captionLayout: Prop.string<"dropdown" | "label">().propertiesPanel({
      label: "Caption layout",
      description: "The layout of the caption",
      controlType: "DROP_DOWN",
      options: [
        { label: "Dropdown", value: "dropdown" },
        { label: "Label", value: "label" },
      ],
    }),
    numberOfMonths: Prop.number().propertiesPanel({
      label: "Number of months",
      description: "Number of months to display in the calendar",
    }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      description: "Disables user interaction with this component",
      controlType: "SWITCH",
    }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onValueChange: Prop.eventHandler().propertiesPanel({
      label: "onValueChange",
      description: "Event handler called when the date range changes",
      computedArgs: [
        [
          {
            type: "string",
            name: "from",
            description: "The start date of the date range",
          },
          {
            type: "string",
            name: "to",
            description: "The end date of the date range",
          },
        ],
      ],
    }),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "date-picker",
};

// Register Component
registerComponent(DateRangePicker, propertiesDefinition).editorConfig(
  editorConfig,
);

export { DateRangePicker };
