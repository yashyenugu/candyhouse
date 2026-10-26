import BaseLayout from "@/layouts/base-layout";
import { NextPageWithLayout } from "@/pages/_app";
// import { api } from "@/utils/api";
import {
  Text,
  Box,
  Card,
  Container,
  Flex,
  SimpleGrid,
  GridItem,
  VStack,
  Button,
  HStack,
  Heading,
  useDisclosure,
  Modal,
  ModalOverlay,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalContent,
  ModalCloseButton,
} from "@chakra-ui/react";
import { useRouter } from "next/router";
import Image from "next/image";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { addCandyToCart, removeCandyFromCart } from "@/store/modules/cart";
import { Form, Formik } from "formik";
import SelectControl from "@/components/ui/select-control";
import InputControl from "@/components/ui/input-control";
import TextareaControl from "@/components/ui/textarea-control";

import { useCandyByIdQuery } from "@/api/candy";
import Seo from "@/components/shared/seo";

const Candy: NextPageWithLayout = () => {
  const router = useRouter();

  const dispatch = useAppDispatch();

  const { isLoading: isCandyLoading, data: candy } = useCandyByIdQuery(
    router.query.id as string
  );

  // const { mutate, isLoading } = api.review.create.useMutation({
  //   onSuccess() {
  //     //
  //   },
  //   onError() {
  //     //
  //   },
  // });

  // const { isLoading: isReviewsLoading, data: reviews } =
  //   api.review.allByCandyId.useQuery({ id: router.query.id as string });

  const cartCandy = useAppSelector((state) => state.cart.items).find(
    (item) => item._id === candy?._id
  );
  if (isCandyLoading) {
    return <></>;
  }

  if (candy)
    return (
      <>
        <Seo title="View Candy" />
        <Container
          maxW="4xl"
          py={{ base: "12", md: "24" }}
          px={{ base: "0", sm: "8" }}
        >
          <Card w="full" px={4} py={3}>
            <SimpleGrid spacingX={6} columns={12} py={2}>
              <GridItem colSpan={3}>
                <Box w="full">
                  <Box position="relative" h="200px">
                    <Image src={candy.photo.url} alt={candy.name} fill />
                  </Box>
                </Box>
              </GridItem>
              <GridItem colSpan={9}>
                <VStack
                  h="full"
                  alignItems="start"
                  justifyContent="space-between"
                  ml={0}
                >
                  <Box>
                    <Text textColor="gray.400" fontSize={"sm"}>
                      {(candy.vendor as any).name}
                    </Text>
                    <Text mt={0} as="h3" fontWeight="medium" fontSize="xl" textTransform="capitalize">
                      {candy.name}
                      
                    </Text>
                    <Text fontSize="sm" fontWeight="normal">
                      {candy.description}
                    </Text>
                  </Box>
                  <Flex
                    justifyContent="space-between"
                    alignItems="center"
                    w="full"
                    flexDirection="row-reverse"
                  >
                    {cartCandy ? (
                      <HStack>
                        <Button
                          isDisabled={cartCandy.itemsInCart >= candy.quantity}
                          onClick={() => {
                            dispatch(addCandyToCart({ candy }));
                          }}
                        >
                          +
                        </Button>
                        <Text>{cartCandy.itemsInCart}</Text>
                        <Button
                          onClick={() => {
                            dispatch(removeCandyFromCart({ candy }));
                          }}
                        >
                          -
                        </Button>
                      </HStack>
                    ) : (
                      <Button
                        isDisabled={candy.quantity < 1}
                        onClick={() => {
                          dispatch(addCandyToCart({ candy }));
                        }}
                      >
                        {candy.quantity < 1 ? "Out of stock" : "Add to Cart"}
                      </Button>
                    )}
                    <Text fontWeight="bold">${candy.price}</Text>
                  </Flex>
                </VStack>
              </GridItem>
            </SimpleGrid>
          </Card>
        </Container>
      </>
    );
};

Candy.getLayout = (page) => {
  return <BaseLayout>{page}</BaseLayout>;
};

export default Candy;
