import { useState, type FormEvent } from "react";
import ICButton from "../ui/ICButton";

interface DealFormProps {
  onSubmit: (data: { name: string; sector: string; description: string }) => void;
  onCancel: () => void;
}

export default function DealForm({ onSubmit, onCancel }: DealFormProps) {
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      sector: sector.trim() || "General",
      description: description.trim(),
    });
  };

  const inputClass =
    "w-full px-3 py-2 bg-ic-dark border border-ic-border rounded-lg text-sm text-ic-text " +
    "placeholder:text-ic-muted/50 focus:outline-none focus:ring-2 focus:ring-ic-turquoise/50 focus:border-ic-turquoise";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-bold text-ic-text/80 mb-1.5">
          Deal Name <span className="text-ic-coral">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Project Atlas"
          className={inputClass}
          required
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-bold text-ic-text/80 mb-1.5">
          Sector
        </label>
        <input
          type="text"
          value={sector}
          onChange={(e) => setSector(e.target.value)}
          placeholder="e.g., Technology / SaaS"
          className={inputClass}
        />
      </div>

      <div>
        <label className="block text-sm font-bold text-ic-text/80 mb-1.5">
          Description{" "}
          <span className="text-ic-muted text-xs font-normal">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief deal description..."
          rows={3}
          className={`${inputClass} resize-none`}
        />
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-ic-border">
        <ICButton variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </ICButton>
        <ICButton type="submit">Create Deal</ICButton>
      </div>
    </form>
  );
}
