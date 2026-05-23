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

		// Imperatively focus the first visible input on mount when autoFocus is set.
		// We can't rely on the zag-js machine's autoFocus prop because Chakra's
		// withProvider HOC only forwards `mask`, not `autoFocus`, to the machine.
		React.useEffect(() => {
			if (!autoFocus) return;
			const first = containerRef.current?.querySelector<HTMLInputElement>(
				"input:not([type=hidden])"
			);
			first?.focus();
		}, [autoFocus]);

		const mergedRef = (el: HTMLDivElement | null) => {
			(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
			if (typeof rootRef === "function") rootRef(el);
			else if (rootRef) (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
		};

		return (
			<ChakraPinInput.Root ref={mergedRef} {...rest} style={{ width: "100%" }}>
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
