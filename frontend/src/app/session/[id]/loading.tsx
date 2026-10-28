import { Spinner } from "@/components/ui/spinner";

export default function Loading() {
	return (
		<div className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-muted-foreground">
			<Spinner /> Loading interview…
		</div>
	);
}
