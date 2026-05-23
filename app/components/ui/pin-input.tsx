import { PinInput as ChakraPinInput, Group } from "@chakra-ui/react";
import * as React from "react";

export interface PinInputProps extends ChakraPinInput.RootProps {
	rootRef?: React.Ref<HTMLDivElement>;
	count?: number;
	inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
	attached?: boolean;
	autoFocus?: boolean;
}

export const PinInput = React.forwardRef<HTMLInputElement, PinInputProps>(
	function PinInput(props, ref) {
		const { count = 4, inputProps, rootRef, attached, autoFocus, ...rest } = props;
		const containerRef = React.useRef<HTMLDivElement>(null);

		// Chakra's withProvider HOC only forwards "mask" to the zag-js machine,
		// so the machine's built-in autoFocus never fires. We implement it
		// imperatively: after the component paints, find the first visible input
		// via the data-ownedby attribute that zag-js sets on each digit input.
		React.useEffect(() => {
			if (!autoFocus) return;
			const el = containerRef.current;
			if (!el) return;
			// Use rAF so the effect runs after the browser has painted the inputs
			const frame = requestAnimationFrame(() => {
				const first = el.querySelector<HTMLInputElement>("input[data-ownedby]");
				first?.focus();
			});
			return () => cancelAnimationFrame(frame);
		}, [autoFocus]);

		// Merge our internal ref with any external rootRef passed by the caller
		const mergedRootRef = React.useCallback((el: HTMLDivElement | null) => {
			(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
			if (typeof rootRef === "function") rootRef(el);
			else if (rootRef) (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
		}, [rootRef]);

		return (
			<ChakraPinInput.Root ref={mergedRootRef} {...rest} style={{ width: "100%" }}>
				<ChakraPinInput.HiddenInput ref={ref} {...inputProps} />
				<ChakraPinInput.Control style={{ display: "flex", width: "100%" }}>
					<Group attached={attached} style={{ display: "flex", width: "100%" }}>
						{Array.from({ length: count }).map((_, index) => (
							<ChakraPinInput.Input key={index} index={index} style={{ flex: 1, minWidth: 0 }} />
						))}
					</Group>
				</ChakraPinInput.Control>
			</ChakraPinInput.Root>
		);
	},
);
