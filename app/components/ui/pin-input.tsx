import { PinInput as ChakraPinInput, Group } from "@chakra-ui/react";
import * as React from "react";

export interface PinInputProps extends ChakraPinInput.RootProps {
	rootRef?: React.Ref<HTMLDivElement>;
	count?: number;
	inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
	attached?: boolean;
}

export const PinInput = React.forwardRef<HTMLInputElement, PinInputProps>(
	function PinInput(props, ref) {
		const { count = 4, inputProps, rootRef, attached, ...rest } = props;
		return (
			<ChakraPinInput.Root ref={rootRef} {...rest} style={{ width: "100%" }}>
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
