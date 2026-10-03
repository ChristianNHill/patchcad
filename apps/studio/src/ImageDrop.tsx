import { useEffect, useRef, useState } from "react";
import { useStudio } from "./store";
import "./image-drop.css";
import { scaledSize, type RefDraft, type RefView } from "./refs";

export type { RefDraft } from "./refs";
const VIEWS: RefView[] = ["front", "side", "back", "top"];
const ACCEPT = ["image/png", "image/jpeg", "image/webp"];

/** Downscaled to MAX_SIDE. PNG stays PNG (line art, renders); jpeg and webp
 *  become jpeg, since LlmImage carries no webp. */
export async function toRefDraft(file: File): Promise<RefDraft | null> {
  if (!ACCEPT.includes(file.type)) return null;
  const bitmap = await createImageBitmap(file);
  const [w, h] = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const mediaType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, mediaType, 0.92));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { id: crypto.randomUUID(), dataB64: btoa(bin), mediaType, url: URL.createObjectURL(blob) };
}

/** Paste (anywhere on the page while mounted), drop, or click to add images;
 *  thumbnails with a view label and a remove button. Controlled. */
export function ImageDrop({
  images,
  onChange,
  max = 4,
  labels = true,
  disabled = false,
}: {
  images: RefDraft[];
  onChange: (images: RefDraft[]) => void;
  max?: number;
  labels?: boolean;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The paste listener outlives renders; it must see the current props.
  const latest = useRef({ images, onChange });
  latest.current = { images, onChange };

  const add = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (picked.length === 0) return;
    const drafts = (await Promise.all(picked.map(toRefDraft))).filter((d): d is RefDraft => d !== null);
    setError(drafts.length < picked.length ? "only PNG, JPEG and WebP images can be used" : null);
    latest.current.onChange([...latest.current.images, ...drafts].slice(0, max));
  };

  useEffect(() => {
    if (disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      void add(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [disabled]);

  const update = (id: string, patch: Partial<RefDraft>) =>
    onChange(images.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const remove = (id: string) => {
    const gone = images.find((i) => i.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    onChange(images.filter((i) => i.id !== id));
  };

  return (
    <div className="image-drop">
      <div
        className="image-drop__zone"
        data-over={over || undefined}
        data-disabled={disabled || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) void add([...e.dataTransfer.files]);
        }}
      >
        {images.map((img) => (
          <figure className="image-drop__thumb" key={img.id}>
            <img src={img.url} alt={img.view ? `${img.view} view reference` : "reference image"} />
            <button
              type="button"
              className="image-drop__remove"
              aria-label="remove image"
              disabled={disabled}
              onClick={() => remove(img.id)}
            >
              ×
            </button>
            {labels && (
              <select
                className="image-drop__view"
                aria-label="which side of the object this shows"
                value={img.view ?? ""}
                disabled={disabled}
                onChange={(e) => update(img.id, { view: (e.target.value || undefined) as RefView | undefined })}
              >
                <option value="">view?</option>
                {VIEWS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </figure>
        ))}
        {images.length < max && (
          <button
            type="button"
            className="btn btn--quiet btn--tiny image-drop__add"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            {images.length === 0 ? "add a reference image (paste, drop or click)" : "add another"}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT.join(",")}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void add(files);
          }}
        />
      </div>
      {error && <div className="contract-editor__error">{error}</div>}
    </div>
  );
}

/** The Welcome prompt's image row: images plus the size and symmetry they are
 *  read with. State lives in the store so the plan request picks it up. */
export function PlanReferences({ disabled = false }: { disabled?: boolean }) {
  const refs = useStudio((s) => s.planRefs);
  const setRefs = useStudio((s) => s.setPlanRefs);
  return (
    <div className="plan-refs">
      <ImageDrop images={refs.images} onChange={(images) => setRefs({ ...refs, images })} disabled={disabled} />
      {refs.images.length > 0 && (
        <div className="plan-refs__options">
          <label className="plan-refs__field">
            height
            <input
              className="input plan-refs__size"
              type="number"
              min={1}
              step={1}
              inputMode="decimal"
              placeholder="mm"
              disabled={disabled}
              value={refs.sizeMm ?? ""}
              onChange={(e) => setRefs({ ...refs, sizeMm: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
            />
            mm
          </label>
          <label className="plan-refs__field">
            <input
              type="checkbox"
              checked={refs.symmetric}
              disabled={disabled}
              onChange={(e) => setRefs({ ...refs, symmetric: e.target.checked })}
            />
            symmetric
          </label>
        </div>
      )}
    </div>
  );
}
