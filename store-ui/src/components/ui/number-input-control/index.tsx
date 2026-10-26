import {
  NumberDecrementStepper,
  NumberIncrementStepper,
  NumberInput,
  NumberInputField,
  NumberInputProps,
  NumberInputStepper,
} from "@chakra-ui/react";
import { useField, useFormikContext } from "formik";
import React, { FC } from "react";

import { BaseProps, FormControl } from "@/components/ui/form-control";


export type NumberInputControlProps = BaseProps & {
  numberInputProps?: NumberInputProps;
  showStepper?: boolean;
  // Keep what the user typed (e.g. "3." or "3.5") instead of forcing a whole number.
  allowDecimals?: boolean;
  children?: React.ReactNode;
};

export const NumberInputControl: FC<NumberInputControlProps> = React.forwardRef(
  (
    props: NumberInputControlProps,
    ref: React.ForwardedRef<HTMLInputElement>
  ) => {
    const {
      name,
      label,
      showStepper = true,
      allowDecimals = false,
      children,
      numberInputProps,
      ...rest
    } = props;
    const [field, { error, touched }] = useField(name);
    const { setFieldValue, isSubmitting } = useFormikContext();

    const $setFieldValue = (name: string) => (value: string) =>
      setFieldValue(name, allowDecimals ? value : parseInt(value) || 0);

    return (
      <FormControl name={name} label={label} {...rest}>
        <NumberInput
          id={name}
          value={field.value}
          onChange={$setFieldValue(name)}
          isInvalid={!!error && touched}
          isDisabled={isSubmitting}
          {...numberInputProps}
        >
          <NumberInputField name={name} ref={ref} type="number" />
          {showStepper && (
            <NumberInputStepper>
              <NumberIncrementStepper />
              <NumberDecrementStepper />
            </NumberInputStepper>
          )}
          {children}
        </NumberInput>
      </FormControl>
    );
  }
);

NumberInputControl.displayName = "NumberInputControl"

export default NumberInputControl;
