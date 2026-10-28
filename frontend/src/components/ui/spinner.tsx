import { cn } from "cn";

export function Spinner({ className }: { className?: string }) {
	return (
		<svg
			className={cn("size-4 animate-spin", className)}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
		>
			<circle
				className="opacity-25"
				cx="12"
				cy="12"
				r="9"
				stroke="currentColor"
				strokeWidth="3"
			/>
			<path
				className="opacity-90"
				d="M21 12a9 9 0 0 0-9-9"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
			/>
		</svg>
	);
}
